/**
 * The correct-it-if-wrong loop.
 *
 * This is reinforcement's feedback structure applied at inference time rather
 * than during training. The agent proposes a change; an external verifier
 * grades it; failures are fed back verbatim; the agent iterates. Nothing here
 * updates model weights — the improvement is per-task, and it comes from
 * refusing to accept unverified work rather than from the model getting better.
 *
 * The grading signal is deliberately outside the agent's reach. Checks are
 * frozen before the first turn, and any edit to a grader file is reported, so
 * "make the tests pass" cannot quietly become "make the tests weaker".
 */

import { execFileSync } from "node:child_process";
import type { RunResult } from "./agent.js";
import type { AgentConfig } from "./config.js";
import {
  allFailures,
  detectChecks,
  findRegressions,
  formatRegressions,
  preExistingFailures,
  verify,
  type Check,
  type Regression,
  type VerificationReport,
} from "./verify.js";

/**
 * The supervisor only ever asks something to run a task. Depending on that
 * rather than on `Agent` keeps the repair logic testable without a model, and
 * `Agent` satisfies it structurally.
 */
export interface TaskRunner {
  run(task: string): Promise<RunResult>;
}

export interface SupervisorOptions {
  /** How many repair rounds to attempt after the first failure. */
  maxRepairAttempts: number;
  /**
   * Treat *any* failing check as actionable, not just ones the agent caused.
   *
   * The default (false) is right when the agent is changing working code: a
   * suite that was already red is somebody else's bug, and chasing it wastes
   * the repair budget. Set this when the task is explicitly to make a red suite
   * green — otherwise the failure is written off as pre-existing and the loop
   * never engages on exactly the work it was asked to do.
   */
  requireGreen?: boolean;
  onPhase?: (message: string) => void;
}

export interface SupervisedResult {
  run: RunResult;
  /** Null when the project has no detectable checks. */
  baseline: VerificationReport | null;
  final: VerificationReport | null;
  /** Regressions still outstanding when the loop gave up. */
  outstanding: Regression[];
  repairAttempts: number;
  /** Checks already failing before the agent started; not its doing. */
  preExisting: string[];
  /** Grader files the agent modified. Non-empty means read the diff carefully. */
  graderFilesTouched: string[];
  verdict: "verified" | "unverified" | "regressed" | "no-checks";
  /** Whether pre-existing failures were treated as the agent's problem. */
  requiredGreen: boolean;
}

/**
 * Files whose contents define whether a check passes. An agent editing one of
 * these while trying to turn a suite green is the classic way a "passing" run
 * is actually a broken one.
 */
function isGraderFile(file: string): boolean {
  return (
    /(^|\/)(package|deno)\.json$/.test(file)
    || /(^|\/)tsconfig[^/]*\.json$/.test(file)
    || /(^|\/)(pyproject\.toml|pytest\.ini|tox\.ini|setup\.cfg)$/.test(file)
    || /(^|\/)Cargo\.toml$/.test(file)
    || /(^|\/)\.eslintrc/.test(file)
    || /(^|\/)eslint\.config\./.test(file)
    || /(^|\/)(test|tests|__tests__|spec)\//.test(file)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
    || /(^|\/)test_[^/]+\.py$/.test(file)
    || /_test\.(py|go|rs)$/.test(file)
  );
}

/**
 * Files changed since the run began, via git. Returns an empty list outside a
 * repository or when git is unavailable — this is a diagnostic, not a gate.
 */
function changedFiles(root: string): string[] {
  const run = (args: string[]): string => {
    try {
      return execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
      });
    } catch {
      return "";
    }
  };
  if (!run(["rev-parse", "--is-inside-work-tree"]).trim().startsWith("true")) return [];

  const tracked = run(["diff", "--name-only", "HEAD"]);
  const untracked = run(["ls-files", "--others", "--exclude-standard"]);
  return [...tracked.split("\n"), ...untracked.split("\n")]
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Run a task, then hold it to the project's own checks, repairing regressions
 * until they clear or the attempt budget runs out.
 */
export async function runSupervised(
  agent: TaskRunner,
  config: AgentConfig,
  task: string,
  options: SupervisorOptions,
): Promise<SupervisedResult> {
  const phase = options.onPhase ?? (() => {});
  const requiredGreen = options.requireGreen === true;

  // Frozen before the agent runs. Re-detecting later would let the agent pick
  // its own grader by editing package.json.
  const checks: Check[] = detectChecks(config.root);

  if (checks.length === 0) {
    phase("no verification commands detected; running unverified");
    const run = await agent.run(task);
    return {
      run,
      baseline: null,
      final: null,
      outstanding: [],
      repairAttempts: 0,
      preExisting: [],
      graderFilesTouched: [],
      verdict: "no-checks",
      requiredGreen,
    };
  }

  phase(`checks: ${checks.map((c) => c.name).join(", ")} — recording baseline`);
  const baseline = await verify(checks, config.root, {
    // No fail-fast at baseline: the whole point is to know the starting state
    // of every check, so a pre-existing failure cannot be mistaken for a
    // regression later.
    failFast: false,
    onCheckStart: (check) => phase(`baseline: ${check.name}`),
  });

  const preExisting = preExistingFailures(baseline);
  if (preExisting.length > 0) {
    phase(
      `already failing before this run: ${preExisting.join(", ")}`
      + (requiredGreen ? " — must still be green to finish" : " — not counted against the agent"),
    );
  }

  const filesBefore = new Set(changedFiles(config.root));
  const run = await agent.run(task);

  let outstanding: Regression[] = [];
  let attempts = 0;

  for (let attempt = 0; attempt <= options.maxRepairAttempts; attempt += 1) {
    phase(attempt === 0 ? "verifying" : `verifying (repair ${attempt}/${options.maxRepairAttempts})`);

    const current = await verify(checks, config.root, {
      onCheckStart: (check) => phase(`check: ${check.name}`),
    });
    outstanding = options.requireGreen ? allFailures(current) : findRegressions(baseline, current);

    if (outstanding.length === 0) {
      const touched = changedFiles(config.root).filter(
        (file) => isGraderFile(file) && !filesBefore.has(file),
      );
      phase(touched.length > 0 ? "verified, but grader files were modified" : "verified");
      return {
        run,
        baseline,
        final: current,
        outstanding: [],
        repairAttempts: attempts,
        preExisting,
        graderFilesTouched: touched,
        verdict: "verified",
        requiredGreen,
      };
    }

    if (attempt === options.maxRepairAttempts) {
      const touched = changedFiles(config.root).filter(
        (file) => isGraderFile(file) && !filesBefore.has(file),
      );
      return {
        run,
        baseline,
        final: current,
        outstanding,
        repairAttempts: attempts,
        preExisting,
        graderFilesTouched: touched,
        verdict: "regressed",
        requiredGreen,
      };
    }

    attempts += 1;
    phase(`${outstanding.map((r) => r.name).join(", ")} failing — sending back for repair`);
    // Feeding the raw command output back matters: a summarised failure loses
    // the line numbers and stack frames that make the fix obvious.
    await agent.run(
      formatRegressions(outstanding, options.requireGreen ? "must-be-green" : "regression"),
    );
  }

  return {
    run,
    baseline,
    final: null,
    outstanding,
    repairAttempts: attempts,
    preExisting,
    graderFilesTouched: [],
    verdict: "unverified",
    requiredGreen,
  };
}

export function formatVerdict(result: SupervisedResult): string {
  const lines: string[] = [];

  switch (result.verdict) {
    case "verified":
      lines.push(
        result.repairAttempts === 0
          ? "Verified: all checks pass, first try."
          : `Verified: all checks pass after ${result.repairAttempts} repair round${result.repairAttempts === 1 ? "" : "s"}.`,
      );
      break;
    case "regressed":
      lines.push(
        `NOT verified: ${result.outstanding.map((r) => r.name).join(", ")} still failing `
        + `after ${result.repairAttempts} repair round${result.repairAttempts === 1 ? "" : "s"}. `
        + "Review the diff before keeping it.",
      );
      break;
    case "no-checks":
      lines.push("Unverified: this project exposes no type check, linter, or test suite to grade against.");
      break;
    default:
      lines.push("Unverified: the verification loop did not reach a verdict.");
  }

  if (result.preExisting.length > 0) {
    lines.push(
      result.requiredGreen
        ? `Was already failing when the run started: ${result.preExisting.join(", ")}.`
        : `Already failing before this run (not caused by the agent): ${result.preExisting.join(", ")}.`,
    );
  }
  if (result.graderFilesTouched.length > 0) {
    lines.push(
      `Warning: the agent modified files that define the checks — ${result.graderFilesTouched.join(", ")}. `
      + "A green run means less when the grader moved; read those changes first.",
    );
  }
  return lines.join("\n");
}
