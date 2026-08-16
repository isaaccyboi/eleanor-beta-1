#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * `npm run agent -- "task"` runs one task to completion; with no task it opens
 * a REPL that keeps conversation history (and therefore the prompt cache)
 * across turns. `npm run web` puts the same agent behind a browser page.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as readline from "node:readline/promises";
import { Agent, type AgentEvents, type RunResult } from "./agent.js";
import type { CostMeter } from "./cost.js";
import { formatVerdict, runSupervised, type SupervisedResult } from "./supervisor.js";
import { detectChecks, formatReport, verify } from "./verify.js";
import {
  DEFAULT_CONFIG,
  EFFORTS,
  HARNESS_NAME,
  HARNESS_VERSION,
  PRICING,
  isKnownModel,
  type AgentConfig,
  type ApprovalMode,
  type Effort,
} from "./config.js";

const USE_COLOR = process.stdout.isTTY && !process.env["NO_COLOR"];
const c = {
  dim: (s: string) => (USE_COLOR ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (USE_COLOR ? `\x1b[1m${s}\x1b[0m` : s),
  cyan: (s: string) => (USE_COLOR ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s: string) => (USE_COLOR ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (USE_COLOR ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (USE_COLOR ? `\x1b[33m${s}\x1b[0m` : s),
};

const HELP = `${HARNESS_NAME} ${HARNESS_VERSION} — a verifying, cost-aware coding agent

${HARNESS_NAME} ${HARNESS_VERSION} is the harness: the agent loop, tools, verifier,
and safety layer. It is not a model. Every request is served by the Claude model
named in --model, and the harness is what decides how well that model is used.

USAGE
  npm run agent -- [options] "task"    run one task and exit
  npm run agent -- [options]           interactive session
  npm run web                          chat interface in a browser

OPTIONS
  -m, --model <id>          model to drive the agent (default: ${DEFAULT_CONFIG.model})
  -e, --effort <level>      ${EFFORTS.join(" | ")} (default: ${DEFAULT_CONFIG.effort})
  -C, --root <dir>          project root; all file and shell access is confined here
      --max-turns <n>       tool-use turns before stopping (default: ${DEFAULT_CONFIG.maxTurns})
      --max-tokens <n>      output cap per response (default: ${DEFAULT_CONFIG.maxTokens})
      --budget <n>          token budget the model paces itself against (min 20000)

  APPROVAL
      --readonly            inspection only; no writes, no edits, no arbitrary shell
      --yes                 run mutating tools without prompting (use in a sandbox)
                            default: prompt before writes, edits, and non-trivial shell

  VERIFICATION
      --no-verify           accept the agent's word instead of running the checks
      --repair-attempts <n> repair rounds after a failed check (default: ${DEFAULT_CONFIG.repairAttempts})
      --require-green       treat an already-failing check as part of the task
                            (default: only failures the agent introduced)
      --check               run the project's checks and exit; no agent, no cost

  COST AND CONTEXT
      --no-cache            disable prompt caching (rarely what you want)
      --no-context-editing  keep every tool result in context instead of pruning
      --no-fallback         do not re-route a refused request to a fallback model

  OTHER
      --web                 enable server-side web search and fetch
      --json                emit newline-delimited JSON events instead of prose
      --list-models         show models with prices
  -h, --help                this message

AUTHENTICATION
  Reads ANTHROPIC_API_KEY from the environment, or an \`ant auth login\` profile.
  This tool ships with no credentials of its own.

COST
  Every run prints tokens, cache hit rate, and estimated dollars. The largest
  levers, in order: --model, prompt caching (on by default), and --effort.`;

interface ParsedArgs {
  config: AgentConfig;
  task: string | null;
  showHelp: boolean;
  listModels: boolean;
  checkOnly: boolean;
  error: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const config: AgentConfig = { ...DEFAULT_CONFIG, root: process.cwd() };
  const positional: string[] = [];
  let showHelp = false;
  let listModels = false;
  let checkOnly = false;
  let error: string | null = null;

  const needValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
      error ??= `${flag} needs a value`;
      return "";
    }
    return value;
  };

  const integer = (flag: string, raw: string): number | null => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      error ??= `${flag} must be a positive number, got "${raw}"`;
      return null;
    }
    return Math.trunc(n);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case "-h":
      case "--help":
        showHelp = true;
        break;
      case "--list-models":
        listModels = true;
        break;
      case "-m":
      case "--model":
        config.model = needValue(arg, i);
        i += 1;
        break;
      case "-e":
      case "--effort": {
        const value = needValue(arg, i);
        if (value && !EFFORTS.includes(value as Effort)) {
          error ??= `--effort must be one of ${EFFORTS.join(", ")}, got "${value}"`;
        } else if (value) {
          config.effort = value as Effort;
        }
        i += 1;
        break;
      }
      case "-C":
      case "--root":
        config.root = path.resolve(needValue(arg, i));
        i += 1;
        break;
      case "--max-turns": {
        const n = integer(arg, needValue(arg, i));
        if (n !== null) config.maxTurns = n;
        i += 1;
        break;
      }
      case "--max-tokens": {
        const n = integer(arg, needValue(arg, i));
        if (n !== null) config.maxTokens = n;
        i += 1;
        break;
      }
      case "--budget": {
        const n = integer(arg, needValue(arg, i));
        if (n !== null) {
          if (n < 20_000) {
            error ??= "--budget must be at least 20000 (the API minimum)";
          } else {
            config.taskBudget = n;
          }
        }
        i += 1;
        break;
      }
      case "--readonly":
        config.approval = "readonly" satisfies ApprovalMode;
        break;
      case "--yes":
      case "--dangerously-skip-approval":
        config.approval = "auto" satisfies ApprovalMode;
        break;
      case "--no-cache":
        config.promptCaching = false;
        break;
      case "--no-context-editing":
        config.contextEditing = false;
        break;
      case "--no-fallback":
        config.refusalFallback = false;
        break;
      case "--no-verify":
        config.verify = false;
        break;
      case "--require-green":
        config.requireGreen = true;
        break;
      case "--check":
        checkOnly = true;
        break;
      case "--repair-attempts": {
        const raw = needValue(arg, i);
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          error ??= `--repair-attempts must be zero or a positive number, got "${raw}"`;
        } else {
          config.repairAttempts = Math.trunc(n);
        }
        i += 1;
        break;
      }
      case "--web":
        config.webTools = true;
        break;
      case "--json":
        config.json = true;
        break;
      default:
        if (arg.startsWith("-")) {
          error ??= `unknown option: ${arg}`;
        } else {
          positional.push(arg);
        }
    }
  }

  return {
    config,
    task: positional.length > 0 ? positional.join(" ") : null,
    showHelp,
    listModels,
    checkOnly,
    error,
  };
}

function listModels(): void {
  const rows = Object.entries(PRICING).map(([id, price]) => ({
    id,
    price: `$${price.input}/$${price.output} per Mtok`,
    note: price.note,
  }));
  const idWidth = Math.max(...rows.map((r) => r.id.length));
  const priceWidth = Math.max(...rows.map((r) => r.price.length));
  console.log(c.bold("Models (input/output, US dollars per million tokens)\n"));
  for (const row of rows) {
    const marker = row.id === DEFAULT_CONFIG.model ? c.green(" *") : "  ";
    console.log(`${marker} ${row.id.padEnd(idWidth)}  ${row.price.padEnd(priceWidth)}  ${c.dim(row.note)}`);
  }
  console.log(c.dim("\n  * default    Cache reads bill at 0.1x input; cache writes at 1.25x."));
}

function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  const brief = (value: unknown, max = 60): string => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined) return "";
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  switch (name) {
    case "read":
    case "write":
      return `${name}(${brief(input["path"])})`;
    case "edit":
      return `edit(${brief(input["path"])})`;
    case "glob":
      return `glob(${brief(input["pattern"])})`;
    case "grep":
      return `grep(/${brief(input["pattern"])}/)`;
    case "bash":
      return `bash(${brief(input["command"], 80)})`;
    default:
      return `${name}(${brief(input, 60)})`;
  }
}

function buildEvents(config: AgentConfig): AgentEvents {
  if (config.json) {
    const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);
    return {
      onToolCall: (name, input) => emit({ type: "tool_call", name, input }),
      onToolResult: (name, result, isError) =>
        emit({ type: "tool_result", name, is_error: isError, result: result.slice(0, 4000) }),
      onNotice: (message) => emit({ type: "notice", message }),
      onTurnEnd: (meter) => emit({ type: "usage", ...meter.toJSON() }),
    };
  }

  let wroteThinkingHeader = false;
  let atLineStart = true;

  return {
    onThinking: (delta) => {
      if (!wroteThinkingHeader) {
        process.stdout.write(c.dim("\nthinking… "));
        wroteThinkingHeader = true;
      }
      // Reasoning summaries are context, not the answer — keep them dim and
      // collapsed to a single flowing line so they cannot be mistaken for output.
      process.stdout.write(c.dim(delta.replace(/\n+/g, " ")));
      atLineStart = false;
    },
    onText: (delta) => {
      if (wroteThinkingHeader) {
        process.stdout.write("\n\n");
        wroteThinkingHeader = false;
      }
      process.stdout.write(delta);
      atLineStart = delta.endsWith("\n");
    },
    onToolCall: (name, input) => {
      wroteThinkingHeader = false;
      if (!atLineStart) process.stdout.write("\n");
      console.log(c.cyan(`  → ${summarizeToolCall(name, input)}`));
      atLineStart = true;
    },
    onToolResult: (name, result, isError) => {
      if (!isError) return;
      const firstLine = result.split("\n")[0] ?? result;
      console.log(c.red(`    ✗ ${firstLine.slice(0, 160)}`));
      atLineStart = true;
    },
    onNotice: (message) => {
      if (!atLineStart) process.stdout.write("\n");
      console.log(c.yellow(`  ! ${message}`));
      atLineStart = true;
    },
  };
}

function printSummary(meter: CostMeter, config: AgentConfig): void {
  if (config.json) return;
  console.log(`\n${c.dim("─".repeat(60))}`);
  console.log(c.dim(meter.summary()));
}

/** Whether verification applies: it is pointless when nothing can change. */
function verificationEnabled(config: AgentConfig): boolean {
  return config.verify && config.approval !== "readonly";
}

/**
 * Run one task, verified if the project supports it, and report the verdict.
 * Returns the underlying run so the caller can inspect why it stopped.
 */
async function executeTask(agent: Agent, config: AgentConfig, task: string): Promise<RunResult> {
  if (!verificationEnabled(config)) {
    const run = await agent.run(task);
    if (run.stoppedBecause !== "completed" && run.finalText) {
      console.log(`\n${c.yellow(run.finalText)}`);
    }
    return run;
  }

  const supervised: SupervisedResult = await runSupervised(agent, config, task, {
    maxRepairAttempts: config.repairAttempts,
    requireGreen: config.requireGreen,
    onPhase: (message) => {
      if (config.json) {
        process.stdout.write(`${JSON.stringify({ type: "phase", message })}\n`);
      } else {
        console.log(c.dim(`  · ${message}`));
      }
    },
  });

  if (supervised.run.stoppedBecause !== "completed" && supervised.run.finalText) {
    console.log(`\n${c.yellow(supervised.run.finalText)}`);
  }

  const verdict = formatVerdict(supervised);
  if (config.json) {
    process.stdout.write(
      `${JSON.stringify({
        type: "verdict",
        verdict: supervised.verdict,
        repair_attempts: supervised.repairAttempts,
        outstanding: supervised.outstanding.map((r) => r.name),
        pre_existing_failures: supervised.preExisting,
        grader_files_touched: supervised.graderFilesTouched,
      })}\n`,
    );
  } else {
    const paint =
      supervised.verdict === "verified"
        ? c.green
        : supervised.verdict === "regressed"
          ? c.red
          : c.yellow;
    console.log(`\n${paint(verdict)}`);
  }

  return supervised.run;
}

async function interactive(agent: Agent, config: AgentConfig): Promise<void> {
  console.log(
    c.bold(`${HARNESS_NAME} ${HARNESS_VERSION}`)
    + c.dim(` harness · model ${config.model} · effort ${config.effort} · ${config.approval} approval`),
  );
  console.log(c.dim(`root: ${config.root}`));
  console.log(
    c.dim(
      verificationEnabled(config)
        ? `verification on (up to ${config.repairAttempts} repair rounds)`
        : "verification off",
    ),
  );
  console.log(c.dim("Type a task. /cost for spend, /exit to quit.\n"));

  for (;;) {
    // A fresh interface per prompt so it never contends with the approval
    // prompt that a tool may open mid-turn.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let line: string;
    try {
      line = await rl.question(c.green("› "));
    } catch {
      rl.close();
      return;
    }
    rl.close();

    const task = line.trim();
    if (task === "") continue;
    if (task === "/exit" || task === "/quit") return;
    if (task === "/cost") {
      console.log(c.dim(agent.costMeter.summary()));
      continue;
    }

    await executeTask(agent, config, task);
    printSummary(agent.costMeter, config);
    console.log();
  }
}

/** `--check`: run the project's checks and exit. No model, no cost. */
async function checkOnly(config: AgentConfig): Promise<number> {
  const checks = detectChecks(config.root);
  if (checks.length === 0) {
    console.log(c.yellow("No type check, linter, or test suite detected in this project."));
    return 0;
  }
  console.log(c.dim(`checks: ${checks.map((check) => check.name).join(", ")}\n`));

  const report = await verify(checks, config.root, {
    failFast: false,
    onCheckStart: (check) => console.log(c.dim(`  running ${check.name}…`)),
  });

  console.log(`\n${formatReport(report)}`);
  for (const result of report.results) {
    if (!result.passed) console.log(`\n${c.red(`--- ${result.name} ---`)}\n${result.output}`);
  }
  return report.passed ? 0 : 1;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.showHelp) {
    console.log(HELP);
    return 0;
  }
  if (parsed.listModels) {
    listModels();
    return 0;
  }
  if (parsed.error) {
    console.error(c.red(`error: ${parsed.error}`));
    console.error(c.dim("run with --help for usage"));
    return 2;
  }

  const { config } = parsed;

  if (!fs.existsSync(config.root) || !fs.statSync(config.root).isDirectory()) {
    console.error(c.red(`error: --root is not a directory: ${config.root}`));
    return 2;
  }
  if (parsed.checkOnly) {
    return await checkOnly(config);
  }
  if (!isKnownModel(config.model)) {
    console.error(
      c.yellow(`warning: no price on file for "${config.model}"; cost will not be estimated.`),
    );
  }
  if (!process.env["ANTHROPIC_API_KEY"] && !process.env["ANTHROPIC_AUTH_TOKEN"]) {
    console.error(
      c.dim("note: ANTHROPIC_API_KEY is not set; falling back to an `ant auth login` profile if one exists."),
    );
  }

  const agent = new Agent(config, buildEvents(config));

  if (parsed.task === null) {
    if (!process.stdin.isTTY) {
      console.error(c.red("error: no task given and stdin is not a terminal"));
      return 2;
    }
    await interactive(agent, config);
    return 0;
  }

  const result = await executeTask(agent, config, parsed.task);
  printSummary(agent.costMeter, config);

  return result.stoppedBecause === "error" ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(c.red(`fatal: ${(error as Error).message}`));
    process.exitCode = 1;
  });
