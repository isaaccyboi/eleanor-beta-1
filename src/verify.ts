/**
 * The reward signal.
 *
 * An agent grading its own work is worth very little — it will report success
 * because it believes it succeeded. This module supplies an external verdict
 * instead: the project's own type checker, linter, and test suite, run as
 * ordinary subprocesses, with a pass/fail the agent cannot argue with.
 *
 * Two integrity properties matter here, and both are easy to get wrong:
 *
 *  1. Checks are detected ONCE, before the agent runs, and the exact command
 *     strings are frozen. If the commands were re-detected afterwards, an agent
 *     that edited `package.json` would be choosing its own grader.
 *
 *  2. Results are compared against a baseline. A suite that was already red
 *     before the agent started is not the agent's failure, and blaming it for
 *     one sends it chasing a bug it did not write.
 */

import * as path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { gradedEnv } from "./subprocess.js";

export interface Check {
  /** Short label, e.g. "typecheck". */
  name: string;
  /** Shell command, frozen at detection time. */
  command: string;
}

export interface CheckResult extends Check {
  passed: boolean;
  /** Combined stdout and stderr, truncated. */
  output: string;
  durationMs: number;
  /** True when the command could not be run at all (missing binary, etc.). */
  errored: boolean;
}

export interface VerificationReport {
  results: CheckResult[];
  /** True when every check that ran passed. */
  passed: boolean;
}

/** A check that passed before the agent ran and fails now. */
export interface Regression {
  name: string;
  command: string;
  output: string;
}

export const VERIFY_LIMITS = {
  timeoutMs: 600_000,
  outputChars: 20_000,
} as const;

/**
 * Detect the project's verification commands.
 *
 * Ordered cheapest-first so a fail-fast run surfaces the quickest signal:
 * a type error should not wait behind a full test suite.
 */
export function detectChecks(root: string): Check[] {
  const checks: Check[] = [];
  const has = (file: string) => existsSync(path.join(root, file));

  // --- Node ---------------------------------------------------------------
  const packageJsonPath = path.join(root, "package.json");
  if (existsSync(packageJsonPath)) {
    let scripts: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, unknown> };
      scripts = parsed.scripts ?? {};
    } catch {
      scripts = {};
    }
    const script = (...names: string[]): string | null => {
      for (const name of names) {
        if (typeof scripts[name] === "string") return name;
      }
      return null;
    };

    const typecheck = script("typecheck", "type-check", "tsc");
    if (typecheck) checks.push({ name: "typecheck", command: `npm run ${typecheck} --silent` });
    else if (has("tsconfig.json")) checks.push({ name: "typecheck", command: "npx tsc --noEmit" });

    const lint = script("lint");
    if (lint) checks.push({ name: "lint", command: `npm run ${lint} --silent` });

    const test = script("test");
    if (test) checks.push({ name: "test", command: "npm test --silent" });

    const build = script("build");
    if (build) checks.push({ name: "build", command: "npm run build --silent" });
  }

  // --- Python -------------------------------------------------------------
  if (has("pyproject.toml") || has("setup.py") || has("pytest.ini") || has("tox.ini")) {
    checks.push({ name: "test", command: "python -m pytest -q" });
  }

  // --- Rust ---------------------------------------------------------------
  if (has("Cargo.toml")) {
    checks.push({ name: "typecheck", command: "cargo check --quiet" });
    checks.push({ name: "test", command: "cargo test --quiet" });
  }

  // --- Go -----------------------------------------------------------------
  if (has("go.mod")) {
    checks.push({ name: "build", command: "go build ./..." });
    checks.push({ name: "test", command: "go test ./..." });
  }

  // De-duplicate by name, keeping the first (cheapest) definition.
  const seen = new Set<string>();
  return checks.filter((check) => {
    if (seen.has(check.name)) return false;
    seen.add(check.name);
    return true;
  });
}

async function runCheck(check: Check, root: string): Promise<CheckResult> {
  const started = Date.now();

  return await new Promise<CheckResult>((resolve) => {
    const child = spawn("bash", ["-c", check.command], {
      cwd: root,
      env: gradedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;
    const cap = VERIFY_LIMITS.outputChars * 2;

    const timer = setTimeout(() => child.kill("SIGKILL"), VERIFY_LIMITS.timeoutMs);

    const collect = (chunk: Buffer) => {
      if (output.length < cap) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const finish = (result: CheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on("error", (error) => {
      finish({
        ...check,
        passed: false,
        errored: true,
        output: `Could not run: ${error.message}`,
        durationMs: Date.now() - started,
      });
    });

    child.on("close", (code, signal) => {
      const timedOut = signal === "SIGKILL";
      finish({
        ...check,
        passed: !timedOut && code === 0,
        errored: timedOut,
        output: timedOut
          ? `Timed out after ${VERIFY_LIMITS.timeoutMs}ms.\n${trim(output)}`
          : trim(output),
        durationMs: Date.now() - started,
      });
    });
  });
}

function trim(text: string): string {
  const clean = text.trim();
  if (clean.length <= VERIFY_LIMITS.outputChars) return clean;
  // Keep the tail: compilers and test runners put the summary at the end.
  return `[…${clean.length - VERIFY_LIMITS.outputChars} earlier characters omitted]\n${clean.slice(-VERIFY_LIMITS.outputChars)}`;
}

/**
 * Run checks in order. With `failFast` the run stops at the first failure,
 * which keeps repair cycles focused on one problem and avoids paying for a
 * full test suite behind a broken type check.
 */
export async function verify(
  checks: readonly Check[],
  root: string,
  options: { failFast?: boolean; onCheckStart?: (check: Check) => void } = {},
): Promise<VerificationReport> {
  const failFast = options.failFast ?? true;
  const results: CheckResult[] = [];

  for (const check of checks) {
    options.onCheckStart?.(check);
    const result = await runCheck(check, root);
    results.push(result);
    if (!result.passed && failFast) break;
  }

  return { results, passed: results.every((r) => r.passed) };
}

/**
 * Compare a fresh report against the baseline, returning only checks that
 * regressed. A check that was already failing is excluded: it is real, but it
 * is not this run's doing, and treating it as such derails the agent.
 */
export function findRegressions(
  baseline: VerificationReport,
  current: VerificationReport,
): Regression[] {
  const baselinePassed = new Map(baseline.results.map((r) => [r.name, r.passed]));

  return current.results
    .filter((result) => {
      if (result.passed) return false;
      // Unknown at baseline (a check that did not run, e.g. behind fail-fast)
      // is treated as a regression: safer to surface it than to hide it.
      return baselinePassed.get(result.name) !== false;
    })
    .map((result) => ({ name: result.name, command: result.command, output: result.output }));
}

/** Checks that were already failing before the agent touched anything. */
export function preExistingFailures(baseline: VerificationReport): string[] {
  return baseline.results.filter((r) => !r.passed).map((r) => r.name);
}

/** All currently failing checks, expressed as actionable items. */
export function allFailures(current: VerificationReport): Regression[] {
  return current.results
    .filter((result) => !result.passed)
    .map((result) => ({ name: result.name, command: result.command, output: result.output }));
}

/**
 * Render failing checks as feedback the agent can act on.
 *
 * The opening sentence differs by mode because the two situations call for
 * different reasoning: a regression means the cause is in the diff just made,
 * whereas a pre-existing failure means the bug is somewhere in the code as it
 * already stood. Telling an agent it broke something it did not break sends it
 * looking in the wrong place.
 */
export function formatRegressions(
  regressions: readonly Regression[],
  mode: "regression" | "must-be-green" = "regression",
): string {
  const blocks = regressions.map(
    (r) => `### ${r.name} failed\n\nCommand: \`${r.command}\`\n\n\`\`\`\n${r.output}\n\`\`\``,
  );
  const opening =
    mode === "regression"
      ? "Verification failed. These checks passed before your changes and fail now, "
        + "so the cause is in what you just did."
      : "Verification failed. These checks must pass before this task is complete. "
        + "They may have been failing before you started — the failure output below is "
        + "the current state either way.";

  return [
    opening,
    "",
    ...blocks,
    "",
    "Diagnose the actual cause and fix it. Do not weaken, skip, or delete a check "
      + "to make it pass, and do not edit the test to match the code unless the test "
      + "itself is provably wrong — say so explicitly if you believe that. "
      + "If you cannot fix it, say plainly what is broken and why.",
  ].join("\n");
}

export function formatReport(report: VerificationReport): string {
  if (report.results.length === 0) return "no checks detected";
  return report.results
    .map((r) => `${r.passed ? "pass" : "FAIL"} ${r.name} (${(r.durationMs / 1000).toFixed(1)}s)`)
    .join("  ·  ");
}
