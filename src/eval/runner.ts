/**
 * Benchmark runner.
 *
 * Each attempt gets a throwaway copy of the fixture, so tasks cannot
 * contaminate one another and a failed run leaves no residue. The agent is
 * pointed at that copy and nothing else; the grader is a subprocess whose exit
 * code is the whole verdict.
 *
 * The one subtlety worth stating: a pass is only a pass if the protected files
 * are byte-identical afterwards. An agent that edits the test to match its code
 * produces a green grader and a worthless result, so protected files are hashed
 * before and after and any change downgrades the outcome to `tampered`.
 */

import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import fg from "fast-glob";

import { gradedEnv } from "../subprocess.js";

import { Agent } from "../agent.js";
import { CostMeter } from "../cost.js";
import { DEFAULT_CONFIG, type AgentConfig } from "../config.js";
import { runSupervised, type TaskRunner } from "../supervisor.js";
import type { EvalConfig, EvalSummary, EvalTask, TaskOutcome, TaskStatus } from "./types.js";

const GRADER_OUTPUT_CHARS = 4_000;

export interface AgentHandle extends TaskRunner {
  readonly costMeter: CostMeter;
}

/** Injectable so the runner can be tested without a model or an API key. */
export type AgentFactory = (config: AgentConfig) => AgentHandle;

export const defaultAgentFactory: AgentFactory = (config) => new Agent(config);

/** Load every task manifest under a directory. */
export async function loadTasks(tasksDir: string): Promise<EvalTask[]> {
  const entries = await fs.readdir(tasksDir, { withFileTypes: true });
  const tasks: EvalTask[] = [];

  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const manifestPath = path.join(tasksDir, entry.name, "task.json");
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, "utf8");
    } catch {
      continue; // directory without a manifest is not a task
    }
    const parsed = JSON.parse(raw) as Omit<EvalTask, "fixtureDir">;
    tasks.push({ ...parsed, fixtureDir: path.join(tasksDir, entry.name, "workspace") });
  }
  return tasks;
}

/** Map every file matching `patterns` to a content hash. */
async function hashProtected(root: string, patterns: readonly string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  if (patterns.length === 0) return hashes;

  const files = await fg([...patterns], {
    cwd: root,
    absolute: false,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    suppressErrors: true,
  });

  for (const file of files.sort()) {
    try {
      const content = await fs.readFile(path.join(root, file));
      hashes.set(file, createHash("sha256").update(content).digest("hex"));
    } catch {
      hashes.set(file, "<unreadable>");
    }
  }
  return hashes;
}

/** Files added, removed, or modified between two hash maps. */
function diffHashes(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [file, hash] of before) {
    if (after.get(file) !== hash) changed.add(file);
  }
  for (const file of after.keys()) {
    if (!before.has(file)) changed.add(file);
  }
  return [...changed].sort();
}

interface GraderResult {
  passed: boolean;
  output: string;
}

function runGrader(command: string, cwd: string, timeoutMs: number): Promise<GraderResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      env: gradedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    const collect = (chunk: Buffer) => {
      if (output.length < GRADER_OUTPUT_CHARS * 3) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const finish = (result: GraderResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on("error", (error) => finish({ passed: false, output: `grader failed to start: ${error.message}` }));
    child.on("close", (code) => {
      const trimmed = output.trim();
      finish({
        passed: code === 0,
        output: trimmed.length > GRADER_OUTPUT_CHARS ? trimmed.slice(-GRADER_OUTPUT_CHARS) : trimmed,
      });
    });
  });
}

export interface RunTaskOptions {
  evalConfig: EvalConfig;
  attempt: number;
  agentFactory?: AgentFactory;
  onPhase?: (message: string) => void;
  /** Keep the workspace on disk for inspection instead of deleting it. */
  keepWorkspace?: boolean;
}

export async function runTask(task: EvalTask, options: RunTaskOptions): Promise<TaskOutcome> {
  const factory = options.agentFactory ?? defaultAgentFactory;
  const started = Date.now();

  const base: Omit<TaskOutcome, "status"> = {
    taskId: task.id,
    attempt: options.attempt,
    turns: 0,
    costUsd: null,
    durationMs: 0,
    repairAttempts: 0,
    tamperedFiles: [],
    graderOutput: "",
    stoppedBecause: "unknown",
  };

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `dhozzi-eval-${task.id}-`));

  try {
    await fs.cp(task.fixtureDir, workspace, { recursive: true });
    const before = await hashProtected(workspace, task.protected);

    const agentConfig: AgentConfig = {
      ...DEFAULT_CONFIG,
      root: workspace,
      model: options.evalConfig.model,
      effort: options.evalConfig.effort,
      maxTurns: options.evalConfig.maxTurns,
      verify: options.evalConfig.verify,
      repairAttempts: options.evalConfig.repairAttempts,
      // A benchmark cannot stop to ask permission, and the workspace is a
      // throwaway copy, so unattended execution is safe here specifically.
      approval: "auto",
      json: false,
    };

    const agent = factory(agentConfig);
    let timedOut = false;

    const deadline = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        resolve("timeout");
      }, task.timeoutMs);
      timer.unref();
    });

    const work = (async () => {
      if (!options.evalConfig.verify) {
        const run = await agent.run(task.prompt);
        return { stoppedBecause: run.stoppedBecause, turns: run.turns, repairAttempts: 0 };
      }
      const supervised = await runSupervised(agent, agentConfig, task.prompt, {
        maxRepairAttempts: options.evalConfig.repairAttempts,
        // Every fixture starts red by construction — that is the task. Without
        // this the suite reads as a pre-existing failure and the repair loop
        // never engages on the one thing it was meant to help with.
        requireGreen: true,
        onPhase: options.onPhase,
      });
      return {
        stoppedBecause: supervised.run.stoppedBecause,
        turns: supervised.run.turns,
        repairAttempts: supervised.repairAttempts,
      };
    })();

    const outcome = await Promise.race([work, deadline]);

    const costUsd = agent.costMeter.costUsd;
    if (outcome === "timeout" || timedOut) {
      return {
        ...base,
        status: "timeout",
        costUsd,
        durationMs: Date.now() - started,
        stoppedBecause: "timeout",
      };
    }

    const grader = await runGrader(task.grade, workspace, 120_000);
    const after = await hashProtected(workspace, task.protected);
    const tampered = diffHashes(before, after);

    let status: TaskStatus;
    if (tampered.length > 0) {
      // Downgraded regardless of the grader: a moved goalpost is not a pass.
      status = "tampered";
    } else if (grader.passed) {
      status = "passed";
    } else if (outcome.stoppedBecause !== "completed") {
      status = "incomplete";
    } else {
      status = "failed";
    }

    return {
      ...base,
      status,
      turns: outcome.turns,
      costUsd,
      durationMs: Date.now() - started,
      repairAttempts: outcome.repairAttempts,
      tamperedFiles: tampered,
      graderOutput: grader.passed ? "" : grader.output,
      stoppedBecause: outcome.stoppedBecause,
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      durationMs: Date.now() - started,
      notes: (error as Error).message,
    };
  } finally {
    if (!options.keepWorkspace) {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export interface RunSuiteOptions extends Omit<RunTaskOptions, "attempt"> {
  onTaskStart?: (task: EvalTask, attempt: number) => void;
  onTaskEnd?: (outcome: TaskOutcome, task: EvalTask) => void;
}

export async function runSuite(
  tasks: readonly EvalTask[],
  options: RunSuiteOptions,
): Promise<EvalSummary> {
  const started = Date.now();
  const outcomes: TaskOutcome[] = [];

  // Sequential on purpose: parallel attempts contend for rate limits and make
  // per-task timing meaningless.
  for (let attempt = 0; attempt < options.evalConfig.repeat; attempt += 1) {
    for (const task of tasks) {
      options.onTaskStart?.(task, attempt);
      const outcome = await runTask(task, { ...options, attempt });
      outcomes.push(outcome);
      options.onTaskEnd?.(outcome, task);
    }
  }

  return summarize(tasks.length, outcomes, options.evalConfig, Date.now() - started);
}

export function summarize(
  totalTasks: number,
  outcomes: readonly TaskOutcome[],
  config: EvalConfig,
  wallClockMs: number,
): EvalSummary {
  const count = (status: TaskStatus) => outcomes.filter((o) => o.status === status).length;
  const passed = count("passed");

  const costs = outcomes.map((o) => o.costUsd).filter((c): c is number => c !== null);
  const totalCostUsd = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;

  return {
    config,
    outcomes: [...outcomes],
    totalTasks,
    attempts: outcomes.length,
    passed,
    failed: count("failed"),
    tampered: count("tampered"),
    incomplete: count("incomplete") + count("timeout"),
    errored: count("error"),
    passRate: outcomes.length === 0 ? 0 : passed / outcomes.length,
    totalCostUsd,
    costPerPassUsd: totalCostUsd !== null && passed > 0 ? totalCostUsd / passed : null,
    wallClockMs,
  };
}
