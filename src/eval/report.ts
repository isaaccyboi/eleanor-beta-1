/**
 * Benchmark reporting.
 *
 * The headline is pass rate and cost per pass. Total spend on its own rewards a
 * configuration that fails everything cheaply, which is exactly the wrong thing
 * to optimise for.
 */

import type { EvalSummary, TaskOutcome, TaskStatus } from "./types.js";

const STATUS_LABEL: Record<TaskStatus, string> = {
  passed: "PASS",
  failed: "FAIL",
  tampered: "TAMPER",
  incomplete: "INCOMPLETE",
  timeout: "TIMEOUT",
  error: "ERROR",
};

function money(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatOutcomeLine(outcome: TaskOutcome): string {
  const parts = [
    STATUS_LABEL[outcome.status].padEnd(10),
    outcome.taskId.padEnd(26),
    `${outcome.turns} turns`.padStart(9),
    money(outcome.costUsd).padStart(9),
    seconds(outcome.durationMs).padStart(8),
  ];
  if (outcome.repairAttempts > 0) parts.push(`${outcome.repairAttempts} repair`);
  if (outcome.tamperedFiles.length > 0) parts.push(`touched ${outcome.tamperedFiles.join(", ")}`);
  return parts.join("  ");
}

export function formatSummary(summary: EvalSummary): string {
  const { config } = summary;
  const lines: string[] = [];

  lines.push("");
  lines.push("=".repeat(78));
  lines.push(
    `model ${config.model}  ·  effort ${config.effort}  ·  `
    + `verification ${config.verify ? `on (${config.repairAttempts} repairs)` : "off"}  ·  `
    + `${config.repeat} attempt${config.repeat === 1 ? "" : "s"} per task`,
  );
  lines.push("=".repeat(78));

  // Per-task breakdown when tasks were repeated, so variance is visible rather
  // than averaged away.
  if (config.repeat > 1) {
    const byTask = new Map<string, TaskOutcome[]>();
    for (const outcome of summary.outcomes) {
      const list = byTask.get(outcome.taskId) ?? [];
      list.push(outcome);
      byTask.set(outcome.taskId, list);
    }
    lines.push("");
    lines.push("Per task (pass rate across attempts):");
    for (const [taskId, outcomes] of byTask) {
      const passes = outcomes.filter((o) => o.status === "passed").length;
      const marks = outcomes.map((o) => (o.status === "passed" ? "." : "x")).join("");
      lines.push(`  ${taskId.padEnd(26)} ${passes}/${outcomes.length}  ${marks}`);
    }
  }

  const pct = (n: number) => `${((n / Math.max(summary.attempts, 1)) * 100).toFixed(0)}%`;

  lines.push("");
  lines.push(`Pass rate       ${summary.passed}/${summary.attempts}  (${pct(summary.passed)})`);
  if (summary.failed > 0) lines.push(`Failed          ${summary.failed}`);
  if (summary.incomplete > 0) lines.push(`Incomplete      ${summary.incomplete}  (stopped early or timed out)`);
  if (summary.errored > 0) lines.push(`Harness errors  ${summary.errored}`);
  if (summary.tampered > 0) {
    lines.push(
      `Tampered        ${summary.tampered}  <-- the agent edited a protected file; `
      + "these are NOT passes",
    );
  }

  lines.push("");
  lines.push(`Total cost      ${money(summary.totalCostUsd)}`);
  lines.push(`Cost per pass   ${money(summary.costPerPassUsd)}`);
  lines.push(`Wall clock      ${seconds(summary.wallClockMs)}`);
  lines.push("");
  lines.push(
    "Compare runs by pass rate first and cost per pass second. Total spend alone "
    + "rewards a setup that fails everything cheaply.",
  );

  return lines.join("\n");
}

export function toJson(summary: EvalSummary): string {
  return JSON.stringify(
    {
      config: summary.config,
      pass_rate: Number(summary.passRate.toFixed(4)),
      attempts: summary.attempts,
      passed: summary.passed,
      failed: summary.failed,
      tampered: summary.tampered,
      incomplete: summary.incomplete,
      errored: summary.errored,
      total_cost_usd: summary.totalCostUsd,
      cost_per_pass_usd: summary.costPerPassUsd,
      wall_clock_ms: summary.wallClockMs,
      outcomes: summary.outcomes,
    },
    null,
    2,
  );
}
