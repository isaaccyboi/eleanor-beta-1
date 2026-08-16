/**
 * Tests for the reward signal and the repair loop.
 *
 * The properties worth defending here are the ones that make the signal
 * trustworthy: pre-existing failures must not be blamed on the agent, checks
 * must be frozen so the agent cannot swap its own grader, and a run that never
 * goes green must be reported as failed rather than quietly accepted.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import {
  detectChecks,
  findRegressions,
  formatRegressions,
  preExistingFailures,
  verify,
  type Check,
  type VerificationReport,
} from "../src/verify.js";
import { runSupervised, type TaskRunner } from "../src/supervisor.js";
import { gradedEnv, STRIPPED_VARIABLES } from "../src/subprocess.js";
import { DEFAULT_CONFIG, type AgentConfig } from "../src/config.js";
import type { RunResult } from "../src/agent.js";
import { CostMeter } from "../src/cost.js";

let workspace: string;

function project(name: string, files: Record<string, string>): string {
  const dir = path.join(workspace, name);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function config(root: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...DEFAULT_CONFIG, root, approval: "auto", ...overrides };
}

const doneResult = (text: string): RunResult => ({
  finalText: text,
  turns: 1,
  stoppedBecause: "completed",
  meter: new CostMeter("claude-opus-5"),
});

/** A stand-in agent that runs a scripted side effect on each turn. */
function scriptedRunner(steps: Array<() => void>): TaskRunner & { prompts: string[] } {
  const prompts: string[] = [];
  let index = 0;
  return {
    prompts,
    async run(task: string) {
      prompts.push(task);
      const step = steps[index];
      index += 1;
      step?.();
      return doneResult("done");
    },
  };
}

function report(entries: Array<[string, boolean]>): VerificationReport {
  return {
    results: entries.map(([name, passed]) => ({
      name,
      command: `run ${name}`,
      passed,
      output: passed ? "" : `${name} failed`,
      durationMs: 1,
      errored: false,
    })),
    passed: entries.every(([, passed]) => passed),
  };
}

before(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dhozzi-verify-")));
});

after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("check detection", () => {
  it("finds npm scripts and orders them cheapest first", () => {
    const root = project("node-full", {
      "package.json": JSON.stringify({
        scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run", build: "tsc" },
      }),
    });
    assert.deepEqual(
      detectChecks(root).map((check) => check.name),
      ["typecheck", "lint", "test", "build"],
    );
  });

  it("falls back to tsc when there is a tsconfig but no typecheck script", () => {
    const root = project("node-tsconfig", {
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "tsconfig.json": "{}",
    });
    const checks = detectChecks(root);
    assert.equal(checks.find((c) => c.name === "typecheck")?.command, "npx tsc --noEmit");
  });

  it("does not invent scripts the project does not define", () => {
    const root = project("node-bare", { "package.json": JSON.stringify({ name: "bare" }) });
    assert.deepEqual(detectChecks(root), []);
  });

  it("survives an unparseable package.json", () => {
    const root = project("node-broken", { "package.json": "{ not json" });
    assert.doesNotThrow(() => detectChecks(root));
    assert.deepEqual(detectChecks(root), []);
  });

  it("detects python, rust, and go projects", () => {
    const py = project("py", { "pyproject.toml": "[project]\nname='x'\n" });
    assert.ok(detectChecks(py).some((c) => c.command.includes("pytest")));

    const rs = project("rs", { "Cargo.toml": "[package]\nname='x'\n" });
    assert.deepEqual(detectChecks(rs).map((c) => c.name), ["typecheck", "test"]);

    const go = project("go", { "go.mod": "module x\n" });
    assert.deepEqual(detectChecks(go).map((c) => c.name), ["build", "test"]);
  });

  it("reports nothing for a project with no recognisable tooling", () => {
    const root = project("plain", { "notes.txt": "hello" });
    assert.deepEqual(detectChecks(root), []);
  });
});

describe("running checks", () => {
  it("passes when the command exits zero and captures output", async () => {
    const root = project("run-pass", { "x.txt": "" });
    const checks: Check[] = [{ name: "test", command: "echo all-green" }];
    const result = await verify(checks, root);
    assert.equal(result.passed, true);
    assert.match(result.results[0]!.output, /all-green/);
  });

  it("fails on a non-zero exit and keeps stderr", async () => {
    const root = project("run-fail", { "x.txt": "" });
    const checks: Check[] = [{ name: "test", command: "echo boom >&2; exit 1" }];
    const result = await verify(checks, root);
    assert.equal(result.passed, false);
    assert.match(result.results[0]!.output, /boom/);
  });

  it("stops at the first failure when failing fast", async () => {
    const root = project("run-failfast", { "x.txt": "" });
    const checks: Check[] = [
      { name: "typecheck", command: "exit 1" },
      { name: "test", command: "echo should-not-run" },
    ];
    const result = await verify(checks, root, { failFast: true });
    assert.equal(result.results.length, 1);
  });

  it("runs every check when not failing fast, so the baseline is complete", async () => {
    const root = project("run-all", { "x.txt": "" });
    const checks: Check[] = [
      { name: "typecheck", command: "exit 1" },
      { name: "test", command: "exit 0" },
    ];
    const result = await verify(checks, root, { failFast: false });
    assert.equal(result.results.length, 2);
    assert.equal(result.results[1]!.passed, true);
  });
});

describe("graded subprocess environment", () => {
  it("strips the variables that corrupt a child's exit code", () => {
    const env = gradedEnv();
    for (const name of STRIPPED_VARIABLES) {
      assert.equal(env[name], undefined, `${name} must not reach a graded command`);
    }
    assert.equal(env["CI"], "1");
    assert.equal(env["NO_COLOR"], "1");
  });

  it("leaves ordinary application configuration alone", () => {
    process.env["DHOZZI_FIXTURE_VAR"] = "keep-me";
    try {
      assert.equal(gradedEnv()["DHOZZI_FIXTURE_VAR"], "keep-me");
    } finally {
      delete process.env["DHOZZI_FIXTURE_VAR"];
    }
  });

  /**
   * The bug this guards against: these tests run under `node --test`, which
   * exports NODE_TEST_CONTEXT. A check that inherits it and itself runs
   * `node --test` exits 0 even when its tests fail — so every graded result
   * came back green. This asserts a genuinely failing suite still reports as
   * failing from inside a test process.
   */
  it("reports a failing nested test suite as failing, even from inside a test run", async () => {
    assert.ok(
      process.env["NODE_TEST_CONTEXT"] !== undefined,
      "precondition: this test must itself run under node --test for the check to be meaningful",
    );

    const root = project("nested-runner", {
      "package.json": JSON.stringify({ name: "f", private: true, type: "module", scripts: { test: "node --test" } }),
      "test/failing.test.js":
        'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("fails on purpose", () => { assert.equal(1, 2); });\n',
    });

    const result = await verify([{ name: "test", command: "npm test --silent" }], root);
    assert.equal(result.passed, false, "a failing nested suite must not be graded as a pass");
  });
});

describe("regression detection", () => {
  it("ignores a check that was already failing", () => {
    const baseline = report([["test", false]]);
    const current = report([["test", false]]);
    assert.deepEqual(findRegressions(baseline, current), []);
    assert.deepEqual(preExistingFailures(baseline), ["test"]);
  });

  it("flags a check that passed before and fails now", () => {
    const regressions = findRegressions(report([["test", true]]), report([["test", false]]));
    assert.equal(regressions.length, 1);
    assert.equal(regressions[0]!.name, "test");
  });

  it("separates a new failure from a pre-existing one in the same run", () => {
    const baseline = report([["typecheck", true], ["test", false]]);
    const current = report([["typecheck", false], ["test", false]]);
    assert.deepEqual(findRegressions(baseline, current).map((r) => r.name), ["typecheck"]);
  });

  it("treats a check absent from the baseline as a regression", () => {
    const regressions = findRegressions(report([]), report([["lint", false]]));
    assert.deepEqual(regressions.map((r) => r.name), ["lint"]);
  });

  it("reports nothing when everything passes", () => {
    assert.deepEqual(findRegressions(report([["test", true]]), report([["test", true]])), []);
  });
});

describe("repair feedback", () => {
  it("includes the raw command output and forbids weakening the check", () => {
    const text = formatRegressions([
      { name: "test", command: "npm test", output: "AssertionError: expected 3 got 4" },
    ]);
    assert.match(text, /AssertionError: expected 3 got 4/);
    assert.match(text, /npm test/);
    assert.match(text, /Do not weaken, skip, or delete a check/);
  });
});

describe("supervised runs", () => {
  it("reports no-checks for a project with nothing to grade against", async () => {
    const root = project("sup-nochecks", { "readme.md": "hi" });
    const result = await runSupervised(scriptedRunner([]), config(root), "do something", {
      maxRepairAttempts: 2,
    });
    assert.equal(result.verdict, "no-checks");
    assert.equal(result.baseline, null);
  });

  it("verifies in one pass when the agent gets it right", async () => {
    const root = project("sup-pass", {
      "package.json": JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }),
    });
    const runner = scriptedRunner([]);
    const result = await runSupervised(runner, config(root), "task", { maxRepairAttempts: 2 });

    assert.equal(result.verdict, "verified");
    assert.equal(result.repairAttempts, 0);
    assert.equal(runner.prompts.length, 1);
  });

  /** A project whose suite is green until `value.txt` stops saying "good". */
  const GREEN_UNTIL_BROKEN = {
    "package.json": JSON.stringify({
      scripts: {
        test: "node -e \"process.exit(require('fs').readFileSync('value.txt','utf8').trim()==='good'?0:1)\"",
      },
    }),
    "value.txt": "good\n",
  };

  it("feeds the failure back and accepts the fix", async () => {
    const root = project("sup-repair", GREEN_UNTIL_BROKEN);
    const value = path.join(root, "value.txt");

    // The first turn regresses a check that was green; the repair turn fixes it.
    const runner = scriptedRunner([
      () => fs.writeFileSync(value, "bad\n"),
      () => fs.writeFileSync(value, "good\n"),
    ]);

    const result = await runSupervised(runner, config(root), "change the value", {
      maxRepairAttempts: 3,
    });

    assert.equal(result.verdict, "verified");
    assert.equal(result.repairAttempts, 1);
    assert.equal(runner.prompts.length, 2);
    assert.match(runner.prompts[1]!, /Verification failed/);
    assert.deepEqual(result.preExisting, []);
  });

  it("gives up and reports a regression when repairs do not work", async () => {
    const root = project("sup-giveup", GREEN_UNTIL_BROKEN);

    // Breaks the suite on the first turn and never repairs it.
    const runner = scriptedRunner([() => fs.writeFileSync(path.join(root, "value.txt"), "bad\n")]);

    const result = await runSupervised(runner, config(root), "break it", { maxRepairAttempts: 2 });

    assert.equal(result.verdict, "regressed");
    assert.equal(result.repairAttempts, 2);
    assert.deepEqual(result.outstanding.map((r) => r.name), ["test"]);
    // One original turn plus one prompt per repair attempt.
    assert.equal(runner.prompts.length, 3);
  });

  it("does not blame the agent for a suite that was already red", async () => {
    const root = project("sup-preexisting", {
      "package.json": JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }),
    });
    const runner = scriptedRunner([]);

    const result = await runSupervised(runner, config(root), "unrelated change", {
      maxRepairAttempts: 2,
    });

    assert.deepEqual(result.preExisting, ["test"]);
    assert.equal(result.verdict, "verified");
    assert.equal(result.repairAttempts, 0);
    // No repair prompt was sent for a failure the agent did not cause.
    assert.equal(runner.prompts.length, 1);
  });

  it("keeps grading against the original command after the agent rewrites package.json", async () => {
    const root = project("sup-frozen", {
      "package.json": JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }),
    });
    // The agent "fixes" the failure by replacing the test script with a no-op.
    const runner = scriptedRunner([
      () =>
        fs.writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }),
        ),
    ]);

    const result = await runSupervised(runner, config(root), "make tests pass", {
      maxRepairAttempts: 1,
    });

    // Baseline froze the failing command, so the swap does not change the grade.
    assert.equal(result.final?.results[0]!.command, "npm test --silent");
    assert.deepEqual(result.preExisting, ["test"]);
  });

  it("flags grader files the agent modified", async () => {
    const root = project("sup-tamper", {
      "package.json": JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }),
      "test/thing.test.js": "// original assertions\n",
    });
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });

    const runner = scriptedRunner([
      () => fs.writeFileSync(path.join(root, "test/thing.test.js"), "// assertions removed\n"),
    ]);

    const result = await runSupervised(runner, config(root), "make it pass", {
      maxRepairAttempts: 1,
    });

    assert.equal(result.verdict, "verified");
    assert.ok(
      result.graderFilesTouched.some((file) => file.includes("thing.test.js")),
      `expected the edited test file to be flagged, got ${JSON.stringify(result.graderFilesTouched)}`,
    );
  });
});
