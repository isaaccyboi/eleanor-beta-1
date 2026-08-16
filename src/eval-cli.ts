#!/usr/bin/env node
/**
 * Benchmark CLI: `npm run eval`.
 *
 * This is how "is it any good?" and "did that change help?" get answered with a
 * number instead of an impression.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import { loadTasks, runSuite } from "./eval/runner.js";
import { formatOutcomeLine, formatSummary, toJson } from "./eval/report.js";
import type { EvalConfig } from "./eval/types.js";
import {
  DEFAULT_CONFIG,
  EFFORTS,
  HARNESS_NAME,
  HARNESS_VERSION,
  isKnownModel,
  type Effort,
} from "./config.js";

const USE_COLOR = process.stdout.isTTY && !process.env["NO_COLOR"];
const paint = {
  dim: (s: string) => (USE_COLOR ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (USE_COLOR ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (USE_COLOR ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (USE_COLOR ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (USE_COLOR ? `\x1b[33m${s}\x1b[0m` : s),
};

const HELP = `${HARNESS_NAME} ${HARNESS_VERSION} — benchmark

Runs the agent against fixture repositories with seeded bugs and grades each
result by running the fixture's own test suite. Every task starts red, and a
pass requires the grader to go green without any protected file being touched.

USAGE
  npm run eval -- [options]

OPTIONS
  -m, --model <id>        model under test (default: ${DEFAULT_CONFIG.model})
  -e, --effort <level>    ${EFFORTS.join(" | ")} (default: ${DEFAULT_CONFIG.effort})
      --no-verify         disable the verification/repair loop
      --repair-attempts <n>  repair rounds when verification is on (default: ${DEFAULT_CONFIG.repairAttempts})
      --max-turns <n>     per-task turn ceiling (default: 40)
      --repeat <n>        attempts per task, for variance (default: 1)
      --tasks <a,b>       run only these task ids
      --list              list available tasks and exit
      --json <file>       also write the full result as JSON
      --keep              keep task workspaces on disk for inspection
  -h, --help              this message

COST
  Each attempt is a full agent session against the API and is billed to your
  key. Six tasks on ${DEFAULT_CONFIG.model} typically costs a few dollars. Use
  --tasks or --model claude-sonnet-5 to spend less while iterating.

READING THE RESULT
  Pass rate first, cost per pass second. A TAMPER result means the agent edited
  a test or config file to force a green grader — it is counted as a failure,
  and it is worth reading the diff when it happens.`;

interface Options {
  evalConfig: EvalConfig;
  only: string[] | null;
  jsonPath: string | null;
  keep: boolean;
  list: boolean;
  help: boolean;
  error: string | null;
}

function parse(argv: string[]): Options {
  const evalConfig: EvalConfig = {
    model: DEFAULT_CONFIG.model,
    effort: DEFAULT_CONFIG.effort,
    verify: true,
    repairAttempts: DEFAULT_CONFIG.repairAttempts,
    maxTurns: 40,
    repeat: 1,
  };
  let only: string[] | null = null;
  let jsonPath: string | null = null;
  let keep = false;
  let list = false;
  let help = false;
  let error: string | null = null;

  const value = (flag: string, i: number): string => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("-")) {
      error ??= `${flag} needs a value`;
      return "";
    }
    return next;
  };
  const positive = (flag: string, raw: string): number | null => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      error ??= `${flag} must be a non-negative number, got "${raw}"`;
      return null;
    }
    return Math.trunc(n);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "--list":
        list = true;
        break;
      case "-m":
      case "--model":
        evalConfig.model = value(arg, i);
        i += 1;
        break;
      case "-e":
      case "--effort": {
        const level = value(arg, i);
        if (level && !EFFORTS.includes(level as Effort)) {
          error ??= `--effort must be one of ${EFFORTS.join(", ")}`;
        } else if (level) {
          evalConfig.effort = level as Effort;
        }
        i += 1;
        break;
      }
      case "--no-verify":
        evalConfig.verify = false;
        break;
      case "--repair-attempts": {
        const n = positive(arg, value(arg, i));
        if (n !== null) evalConfig.repairAttempts = n;
        i += 1;
        break;
      }
      case "--max-turns": {
        const n = positive(arg, value(arg, i));
        if (n !== null && n > 0) evalConfig.maxTurns = n;
        i += 1;
        break;
      }
      case "--repeat": {
        const n = positive(arg, value(arg, i));
        if (n !== null && n > 0) evalConfig.repeat = n;
        i += 1;
        break;
      }
      case "--tasks":
        only = value(arg, i).split(",").map((s) => s.trim()).filter(Boolean);
        i += 1;
        break;
      case "--json":
        jsonPath = value(arg, i);
        i += 1;
        break;
      case "--keep":
        keep = true;
        break;
      default:
        error ??= `unknown option: ${arg}`;
    }
  }

  return { evalConfig, only, jsonPath, keep, list, help, error };
}

function statusPaint(status: string): (s: string) => string {
  if (status === "passed") return paint.green;
  if (status === "tampered" || status === "error") return paint.red;
  if (status === "failed") return paint.red;
  return paint.yellow;
}

async function main(): Promise<number> {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.error) {
    console.error(paint.red(`error: ${options.error}`));
    console.error(paint.dim("run with --help for usage"));
    return 2;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  // Resolves from both src/ (tsx) and dist/ (compiled).
  const tasksDir = [
    path.resolve(here, "../evals/tasks"),
    path.resolve(here, "../../evals/tasks"),
  ].find((candidate) => existsSync(candidate));

  if (!tasksDir) {
    console.error(paint.red("error: could not locate evals/tasks"));
    return 1;
  }

  let tasks = await loadTasks(tasksDir);
  if (options.only) {
    const wanted = new Set(options.only);
    const missing = options.only.filter((id) => !tasks.some((t) => t.id === id));
    if (missing.length > 0) {
      console.error(paint.red(`error: no such task(s): ${missing.join(", ")}`));
      return 2;
    }
    tasks = tasks.filter((task) => wanted.has(task.id));
  }

  if (options.list) {
    console.log(paint.bold(`${tasks.length} task(s):\n`));
    for (const task of tasks) {
      console.log(`  ${task.id.padEnd(26)} ${task.difficulty.padEnd(7)} ${task.title}`);
      console.log(paint.dim(`  ${" ".repeat(26)} skills: ${task.skills.join(", ")}`));
    }
    return 0;
  }

  if (tasks.length === 0) {
    console.error(paint.red("error: no tasks to run"));
    return 2;
  }
  if (!process.env["ANTHROPIC_API_KEY"] && !process.env["ANTHROPIC_AUTH_TOKEN"]) {
    console.error(
      paint.dim("note: ANTHROPIC_API_KEY is not set; falling back to an `ant auth login` profile if one exists."),
    );
  }
  if (!isKnownModel(options.evalConfig.model)) {
    console.error(paint.yellow(`warning: no price on file for "${options.evalConfig.model}"; cost will read as —`));
  }

  const totalAttempts = tasks.length * options.evalConfig.repeat;
  console.log(
    paint.bold(`${HARNESS_NAME} ${HARNESS_VERSION} benchmark`)
    + paint.dim(` · ${tasks.length} task(s) × ${options.evalConfig.repeat} = ${totalAttempts} attempt(s)`),
  );
  console.log(paint.dim("each attempt is a billed agent session\n"));

  const summary = await runSuite(tasks, {
    evalConfig: options.evalConfig,
    keepWorkspace: options.keep,
    onTaskStart: (task, attempt) => {
      const suffix = options.evalConfig.repeat > 1 ? ` (attempt ${attempt + 1})` : "";
      process.stdout.write(paint.dim(`▸ ${task.id}${suffix}… `));
    },
    onTaskEnd: (outcome) => {
      process.stdout.write("\n");
      console.log(`  ${statusPaint(outcome.status)(formatOutcomeLine(outcome))}`);
      if (outcome.status === "tampered") {
        console.log(paint.red(`  ! protected files changed: ${outcome.tamperedFiles.join(", ")}`));
      }
      if (outcome.notes) console.log(paint.dim(`  ${outcome.notes}`));
    },
  });

  console.log(formatSummary(summary));

  if (options.jsonPath) {
    await writeFile(options.jsonPath, toJson(summary), "utf8");
    console.log(paint.dim(`\nwrote ${options.jsonPath}`));
  }

  // Non-zero when nothing passed, so CI can gate on it.
  return summary.passed === 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(paint.red(`fatal: ${(error as Error).message}`));
    process.exitCode = 1;
  });
