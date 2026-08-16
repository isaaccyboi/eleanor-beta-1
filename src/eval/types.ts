/**
 * Benchmark types.
 *
 * A task is graded by running a command, not by asking a model whether the work
 * looks right. Model-graded benchmarks drift; an exit code does not.
 */

import type { Effort } from "../config.js";

export interface EvalTask {
  id: string;
  title: string;
  difficulty: "easy" | "medium" | "hard";
  skills: string[];
  /** What the agent is asked to do. Phrased as a user would phrase it. */
  prompt: string;
  /** Shell command run in the workspace after the agent finishes. Exit 0 = solved. */
  grade: string;
  /**
   * Globs the agent must not alter. Editing the grading surface to force a pass
   * is the single most important failure mode for a benchmark to catch, so a
   * run that touches these is recorded as `tampered`, never as `passed`.
   */
  protected: string[];
  timeoutMs: number;
  /** Absolute path to the pristine fixture workspace. */
  fixtureDir: string;
}

export type TaskStatus =
  /** Grader exited zero and nothing protected was touched. */
  | "passed"
  /** Grader exited non-zero. */
  | "failed"
  /** Grader may have passed, but a protected file changed. Not a real pass. */
  | "tampered"
  /** The agent stopped early: turn limit, refusal, API error. */
  | "incomplete"
  /** Ran past the task's time budget. */
  | "timeout"
  /** The harness itself broke. */
  | "error";

export interface TaskOutcome {
  taskId: string;
  status: TaskStatus;
  /** Zero-based index when a task is repeated for variance. */
  attempt: number;
  turns: number;
  costUsd: number | null;
  durationMs: number;
  /** Repair rounds spent by the verification loop, when enabled. */
  repairAttempts: number;
  /** Protected files that changed, if any. */
  tamperedFiles: string[];
  /** Grader output, truncated. Empty on a pass. */
  graderOutput: string;
  /** Why the agent loop stopped. */
  stoppedBecause: string;
  notes?: string;
}

export interface EvalConfig {
  model: string;
  effort: Effort;
  verify: boolean;
  repairAttempts: number;
  maxTurns: number;
  /** Attempts per task. Agents are stochastic; one sample is an anecdote. */
  repeat: number;
}

export interface EvalSummary {
  config: EvalConfig;
  outcomes: TaskOutcome[];
  totalTasks: number;
  attempts: number;
  passed: number;
  failed: number;
  tampered: number;
  incomplete: number;
  errored: number;
  /** passed / attempts. */
  passRate: number;
  totalCostUsd: number | null;
  /** Total spend divided by passes — the number that actually matters. */
  costPerPassUsd: number | null;
  wallClockMs: number;
}
