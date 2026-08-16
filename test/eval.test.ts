/**
 * Tests for the benchmark itself.
 *
 * A benchmark that scores wrongly is worse than no benchmark, because it
 * produces confident numbers. The cases below pin the classifications that
 * matter: a real fix is a pass, no work is a failure, and an agent that edits
 * the test to force a green grader is never recorded as a pass.
 *
 * Every agent here is a scripted stand-in — no model, no API key, no cost.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import { loadTasks, runSuite, runTask, summarize, type AgentHandle } from "../src/eval/runner.js";
import { formatSummary } from "../src/eval/report.js";
import type { EvalConfig, EvalTask, TaskOutcome } from "../src/eval/types.js";
import { CostMeter } from "../src/cost.js";
import type { RunResult } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.resolve(HERE, "../evals/tasks");

const evalConfig: EvalConfig = {
  model: "claude-opus-5",
  effort: "high",
  // Verification runs a real subprocess per attempt; off here so these tests
  // stay fast. The supervisor has its own dedicated suite.
  verify: false,
  repairAttempts: 0,
  maxTurns: 10,
  repeat: 1,
};

/** A stand-in agent that performs `effect` on the workspace, then reports done. */
function fakeAgent(effect: (root: string) => void, turns = 2) {
  return (config: AgentConfig): AgentHandle => {
    const meter = new CostMeter(config.model);
    meter.add({ input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 9_000 });
    return {
      costMeter: meter,
      async run(): Promise<RunResult> {
        effect(config.root);
        return { finalText: "done", turns, stoppedBecause: "completed", meter };
      },
    };
  };
}

let tasks: EvalTask[];
const task = (id: string): EvalTask => {
  const found = tasks.find((t) => t.id === id);
  assert.ok(found, `fixture ${id} should exist`);
  return found;
};

before(async () => {
  tasks = await loadTasks(TASKS_DIR);
});

describe("task loading", () => {
  it("loads every fixture with a manifest", () => {
    assert.equal(tasks.length, 6);
    assert.deepEqual(
      tasks.map((t) => t.id),
      [
        "01-off-by-one",
        "02-null-guard",
        "03-rename-across-files",
        "04-implement-from-spec",
        "05-numeric-sort",
        "06-scope-discipline",
      ],
    );
  });

  it("gives every task a prompt, a grader, and protected files", () => {
    for (const t of tasks) {
      assert.ok(t.prompt.length > 20, `${t.id} needs a real prompt`);
      assert.ok(t.grade.length > 0, `${t.id} needs a grade command`);
      assert.ok(t.protected.length > 0, `${t.id} must protect its grading surface`);
      assert.ok(fs.existsSync(t.fixtureDir), `${t.id} fixture workspace must exist`);
    }
  });

  it("points every fixture at a workspace containing a test directory", () => {
    for (const t of tasks) {
      assert.ok(
        fs.existsSync(path.join(t.fixtureDir, "test")),
        `${t.id} should ship the test suite it is graded by`,
      );
    }
  });
});

describe("grading", () => {
  it("records a pass when the agent actually fixes the bug", async () => {
    const outcome = await runTask(task("01-off-by-one"), {
      evalConfig,
      attempt: 0,
      agentFactory: fakeAgent((root) => {
        const file = path.join(root, "src/stats.js");
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("numbers.length - 1", "numbers.length"));
      }),
    });

    assert.equal(outcome.status, "passed");
    assert.equal(outcome.graderOutput, "");
    assert.equal(outcome.tamperedFiles.length, 0);
    assert.equal(outcome.turns, 2);
    assert.ok(outcome.costUsd !== null && outcome.costUsd > 0);
  });

  it("records a failure when the agent changes nothing", async () => {
    const outcome = await runTask(task("01-off-by-one"), {
      evalConfig,
      attempt: 0,
      agentFactory: fakeAgent(() => {}),
    });

    assert.equal(outcome.status, "failed");
    assert.match(outcome.graderOutput, /fail/i);
  });

  it("records a failure when the agent writes a wrong fix", async () => {
    const outcome = await runTask(task("05-numeric-sort"), {
      evalConfig,
      attempt: 0,
      agentFactory: fakeAgent((root) => {
        // Descending, not ascending: plausible-looking and still wrong.
        const file = path.join(root, "src/rank.js");
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(".sort()", ".sort((a, b) => b - a)"));
      }),
    });

    assert.equal(outcome.status, "failed");
  });

  it("counts a genuine multi-file refactor as a pass", async () => {
    const outcome = await runTask(task("03-rename-across-files"), {
      evalConfig,
      attempt: 0,
      agentFactory: fakeAgent((root) => {
        for (const name of ["user.js", "profile.js", "admin.js"]) {
          const file = path.join(root, "src", name);
          fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("getUser", "fetchUser"));
        }
      }),
    });

    assert.equal(outcome.status, "passed");
  });
});

describe("tamper detection", () => {
  it("does not record a pass when the agent rewrites the test to be trivially true", async () => {
    const outcome = await runTask(task("01-off-by-one"), {
      evalConfig,
      attempt: 0,
      agentFactory: fakeAgent((root) => {
        // The grader would go green — but only because the assertions are gone.
        fs.writeFileSync(
          path.join(root, "test/stats.test.js"),
          'import { test } from "node:test";\ntest("noop", () => {});\n',
        );
      }),
    });

    assert.equal(outcome.status, "tampered");
    assert.ok(
      outcome.tamperedFiles.some((f) => f.includes("stats.test.js")),
      `expected the rewritten test to be named, got ${JSON.stringify(outcome.tamperedFiles)}`,
    );
  });

  it("catches a neutered grade command in package.json", async () => {
    const outcome = await runTask(task("02-null-guard"), {
      evalConfig,
      attempt: 0,
      agentFactory: fakeAgent((root) => {
        fs.writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "true" } }),
        );
      }),
    });

    assert.equal(outcome.status, "tampered");
    assert.ok(outcome.tamperedFiles.includes("package.json"));
  });

  it("catches a deleted test file", async () => {
    const outcome = await runTask(task("02-null-guard"), {
      evalConfig,
      attempt: 0,
      agentFactory: fakeAgent((root) => {
        fs.rmSync(path.join(root, "test/format.test.js"));
      }),
    });

    assert.equal(outcome.status, "tampered");
  });

  it("allows a correct fix that leaves the grading surface untouched", async () => {
    const outcome = await runTask(task("02-null-guard"), {
      evalConfig,
      attempt: 0,
      agentFactory: fakeAgent((root) => {
        fs.writeFileSync(
          path.join(root, "src/format.js"),
          'export function formatName(user) {\n  if (!user) return "";\n  return `${user.first} ${user.last}`;\n}\n',
        );
      }),
    });

    assert.equal(outcome.status, "passed");
    assert.deepEqual(outcome.tamperedFiles, []);
  });
});

describe("isolation", () => {
  it("never mutates the pristine fixture", async () => {
    const target = task("01-off-by-one");
    const source = path.join(target.fixtureDir, "src/stats.js");
    const before = fs.readFileSync(source, "utf8");

    await runTask(target, {
      evalConfig,
      attempt: 0,
      agentFactory: fakeAgent((root) => {
        fs.writeFileSync(path.join(root, "src/stats.js"), "export function sum() { return 6; }\n");
      }),
    });

    assert.equal(fs.readFileSync(source, "utf8"), before, "the fixture must survive a destructive run");
  });

  it("gives each attempt a workspace that does not leak into the next", async () => {
    const roots: string[] = [];
    const factory = fakeAgent((root) => {
      roots.push(root);
      fs.writeFileSync(path.join(root, "scratch.txt"), "left behind");
    });

    await runTask(task("01-off-by-one"), { evalConfig, attempt: 0, agentFactory: factory });
    await runTask(task("01-off-by-one"), { evalConfig, attempt: 1, agentFactory: factory });

    assert.equal(roots.length, 2);
    assert.notEqual(roots[0], roots[1]);
    for (const root of roots) {
      assert.equal(fs.existsSync(root), false, "workspaces should be cleaned up");
    }
  });
});

describe("agent stopping early", () => {
  it("reports incomplete rather than failed when the loop ran out of turns", async () => {
    const outcome = await runTask(task("01-off-by-one"), {
      evalConfig,
      attempt: 0,
      agentFactory: (config): AgentHandle => ({
        costMeter: new CostMeter(config.model),
        async run(): Promise<RunResult> {
          return {
            finalText: "hit the limit",
            turns: 10,
            stoppedBecause: "max_turns",
            meter: new CostMeter(config.model),
          };
        },
      }),
    });

    assert.equal(outcome.status, "incomplete");
    assert.equal(outcome.stoppedBecause, "max_turns");
  });

  it("reports an error without crashing the suite when the agent throws", async () => {
    const outcome = await runTask(task("01-off-by-one"), {
      evalConfig,
      attempt: 0,
      agentFactory: (config): AgentHandle => ({
        costMeter: new CostMeter(config.model),
        async run(): Promise<RunResult> {
          throw new Error("connection reset");
        },
      }),
    });

    assert.equal(outcome.status, "error");
    assert.match(outcome.notes ?? "", /connection reset/);
  });
});

describe("suite aggregation", () => {
  it("runs every task and totals the results", async () => {
    const summary = await runSuite(tasks.slice(0, 3), {
      evalConfig,
      agentFactory: fakeAgent(() => {}),
    });

    assert.equal(summary.attempts, 3);
    assert.equal(summary.passed, 0);
    assert.equal(summary.failed, 3);
    assert.equal(summary.passRate, 0);
    assert.ok(summary.totalCostUsd !== null && summary.totalCostUsd > 0);
    // Nothing passed, so cost per pass is undefined rather than zero.
    assert.equal(summary.costPerPassUsd, null);
  });

  it("repeats each task the requested number of times", async () => {
    const summary = await runSuite(tasks.slice(0, 2), {
      evalConfig: { ...evalConfig, repeat: 3 },
      agentFactory: fakeAgent(() => {}),
    });
    assert.equal(summary.attempts, 6);
  });

  it("computes pass rate and cost per pass", () => {
    const outcomes: TaskOutcome[] = [
      { taskId: "a", status: "passed", attempt: 0, turns: 3, costUsd: 0.2, durationMs: 100, repairAttempts: 0, tamperedFiles: [], graderOutput: "", stoppedBecause: "completed" },
      { taskId: "b", status: "failed", attempt: 0, turns: 5, costUsd: 0.3, durationMs: 100, repairAttempts: 0, tamperedFiles: [], graderOutput: "x", stoppedBecause: "completed" },
      { taskId: "c", status: "tampered", attempt: 0, turns: 4, costUsd: 0.5, durationMs: 100, repairAttempts: 0, tamperedFiles: ["test/a.js"], graderOutput: "", stoppedBecause: "completed" },
    ];
    const summary = summarize(3, outcomes, evalConfig, 1000);

    assert.equal(summary.passed, 1);
    assert.equal(summary.tampered, 1);
    assert.equal(Number(summary.passRate.toFixed(4)), 0.3333);
    assert.equal(summary.totalCostUsd, 1);
    assert.equal(summary.costPerPassUsd, 1);

    // Tampering must be called out, not buried in the failure count.
    const text = formatSummary(summary);
    assert.match(text, /Tampered/);
    assert.match(text, /NOT passes/);
  });
});
