/**
 * Tests for the web front end.
 *
 * The properties worth defending are the ones that would be expensive to
 * discover in production: that a page on another origin cannot drive the agent,
 * that read mode really is read-only, that a session reuses one agent so the
 * prompt cache survives, and that the verification verdict reaches the browser
 * rather than being swallowed by the stream.
 *
 * No test here contacts the API — the agent is injected.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { startServer, type RunningServer } from "../src/web/server.js";
import {
  Session,
  SessionStore,
  describeToolCall,
  type AgentLike,
  type SessionSettings,
  type WebEvent,
} from "../src/web/sessions.js";
import { DEFAULT_CONFIG, type AgentConfig } from "../src/config.js";
import type { AgentEvents, RunResult } from "../src/agent.js";
import { CostMeter } from "../src/cost.js";

let workspace: string;

function project(name: string, files: Record<string, string>): string {
  const dir = path.join(workspace, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

const SETTINGS: SessionSettings = {
  model: DEFAULT_CONFIG.model,
  effort: DEFAULT_CONFIG.effort,
  mode: "read",
  verify: true,
};

/** A stand-in agent that replays scripted events and side effects per turn. */
interface Script {
  /** Called once per `run`; may emit events and touch the filesystem. */
  turn: (events: AgentEvents, task: string) => void | Promise<void>;
}

interface StubRecord {
  /** One entry per constructed agent — length is how often history was reset. */
  configs: AgentConfig[];
  tasks: string[];
}

function stubFactory(scripts: Script[], record: StubRecord) {
  let turnIndex = 0;
  return (config: AgentConfig, events: AgentEvents): AgentLike => {
    record.configs.push(config);
    const meter = new CostMeter(config.model);
    return {
      costMeter: meter,
      async run(task: string): Promise<RunResult> {
        record.tasks.push(task);
        const script = scripts[turnIndex];
        turnIndex += 1;
        await script?.turn(events, task);
        meter.add({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900 });
        events.onTurnEnd?.(meter);
        return { finalText: "done", turns: 1, stoppedBecause: "completed", meter };
      },
    };
  };
}

interface Harness extends RunningServer {
  url: string;
  record: StubRecord;
}

async function serve(
  root: string,
  scripts: Script[] = [],
  settings: SessionSettings = SETTINGS,
): Promise<Harness> {
  const record: StubRecord = { configs: [], tasks: [] };
  const running = await startServer({
    root,
    port: 0,
    host: "127.0.0.1",
    settings,
    agentFactory: stubFactory(scripts, record),
  });
  return { ...running, url: `http://localhost:${running.port}`, record };
}

async function newSession(harness: Harness, settings: SessionSettings = SETTINGS) {
  const res = await fetch(`${harness.url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings }),
  });
  return (await res.json()) as { sessionId: string; checks: string[]; root: string };
}

/** Send a task and collect every streamed event. */
async function chat(
  harness: Harness,
  sessionId: string,
  task: string,
  settings: SessionSettings = SETTINGS,
): Promise<WebEvent[]> {
  const res = await fetch(`${harness.url}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, task, settings }),
  });
  assert.equal(res.status, 200, `expected a stream, got ${res.status}`);
  const body = await res.text();
  return body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WebEvent);
}

const kinds = (events: WebEvent[]) => events.map((event) => event.type);

/**
 * A raw request, because `fetch` treats `Host` as a forbidden header and
 * rewrites it — which is exactly the header the rebinding guard inspects.
 */
function rawGet(port: number, requestPath: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: requestPath, method: "GET", headers, setHost: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

before(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chaikan-web-")));
});

after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("origin protection", () => {
  it("serves a request that addresses the server as localhost", async () => {
    const harness = await serve(project("guard-ok", { "a.txt": "" }));
    try {
      const res = await fetch(`${harness.url}/api/config`);
      assert.equal(res.status, 200);
    } finally {
      await harness.close();
    }
  });

  /**
   * DNS rebinding: a hostile domain points its own name at 127.0.0.1, so the
   * browser connects here but still sends the attacker's Host header.
   */
  it("refuses a request whose Host header is not loopback", async () => {
    const harness = await serve(project("guard-host", { "a.txt": "" }));
    try {
      const rebound = await rawGet(harness.port, "/api/config", {
        host: "totally-not-evil.example.com",
      });
      assert.equal(rebound.status, 403);
      assert.match(rebound.body, /localhost/);

      // The same request with an honest Host is served, so the 403 above is
      // the guard firing rather than the route being broken.
      const honest = await rawGet(harness.port, "/api/config", { host: `localhost:${harness.port}` });
      assert.equal(honest.status, 200);
    } finally {
      await harness.close();
    }
  });

  /**
   * Node rejects a Host-less HTTP/1.1 request at the protocol level with a 400
   * before the guard sees it. Either way it is refused; the assertion is on
   * that, not on which layer said no.
   */
  it("refuses a request with no Host header at all", async () => {
    const harness = await serve(project("guard-nohost", { "a.txt": "" }));
    try {
      const res = await rawGet(harness.port, "/api/config", {});
      assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    } finally {
      await harness.close();
    }
  });

  it("refuses a cross-origin request even when the Host is right", async () => {
    const harness = await serve(project("guard-origin", { "a.txt": "" }));
    try {
      const res = await fetch(`${harness.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example.com" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 403);
      assert.match(((await res.json()) as { error: string }).error, /cross-origin/i);
    } finally {
      await harness.close();
    }
  });

  it("allows the page's own origin", async () => {
    const harness = await serve(project("guard-same", { "a.txt": "" }));
    try {
      const res = await fetch(`${harness.url}/api/config`, {
        headers: { origin: harness.url },
      });
      assert.equal(res.status, 200);
    } finally {
      await harness.close();
    }
  });
});

describe("static surface", () => {
  it("serves the page with a title and no external references", async () => {
    const harness = await serve(project("page", { "a.txt": "" }));
    try {
      const res = await fetch(`${harness.url}/`);
      const html = await res.text();
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      assert.match(html, /<title>Chai-Kan 7\.74<\/title>/);
      // A strict CSP is pointless if the page then loads something remote.
      assert.equal(/<(script|link|img)[^>]+(src|href)=["']https?:/i.test(html), false);
    } finally {
      await harness.close();
    }
  });

  it("reports the product identity and model catalogue", async () => {
    const harness = await serve(project("config", { "a.txt": "" }));
    try {
      const body = (await (await fetch(`${harness.url}/api/config`)).json()) as {
        product: { vendor: string; name: string; version: string };
        models: Array<{ id: string; input: number }>;
        root: string;
      };
      assert.equal(body.product.vendor, "Dhozzi");
      assert.equal(body.product.name, "Chai-Kan");
      assert.equal(body.product.version, "7.74");
      assert.ok(body.models.some((m) => m.id === DEFAULT_CONFIG.model));
    } finally {
      await harness.close();
    }
  });

  it("404s an unknown route", async () => {
    const harness = await serve(project("notfound", { "a.txt": "" }));
    try {
      assert.equal((await fetch(`${harness.url}/api/nope`)).status, 404);
    } finally {
      await harness.close();
    }
  });
});

describe("sessions", () => {
  it("reports the checks a run would be graded against", async () => {
    const root = project("sess-checks", {
      "package.json": JSON.stringify({ scripts: { test: "node -e ''", lint: "true" } }),
    });
    const harness = await serve(root);
    try {
      const session = await newSession(harness);
      assert.deepEqual(session.checks, ["lint", "test"]);
      assert.equal(session.root, root);
    } finally {
      await harness.close();
    }
  });

  it("says so plainly when a project has nothing to grade against", async () => {
    const harness = await serve(project("sess-nochecks", { "notes.txt": "hi" }));
    try {
      assert.deepEqual((await newSession(harness)).checks, []);
    } finally {
      await harness.close();
    }
  });

  it("rejects a task for a session that does not exist", async () => {
    const harness = await serve(project("sess-unknown", { "a.txt": "" }));
    try {
      const res = await fetch(`${harness.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "nope", task: "hello" }),
      });
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("rejects an empty task", async () => {
    const harness = await serve(project("sess-empty", { "a.txt": "" }));
    try {
      const { sessionId } = await newSession(harness);
      const res = await fetch(`${harness.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, task: "   " }),
      });
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });

  it("deletes a session on request", async () => {
    const harness = await serve(project("sess-delete", { "a.txt": "" }));
    try {
      const { sessionId } = await newSession(harness);
      const res = await fetch(`${harness.url}/api/session/${sessionId}`, { method: "DELETE" });
      assert.deepEqual(await res.json(), { deleted: true });

      const after = await fetch(`${harness.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, task: "hello" }),
      });
      assert.equal(after.status, 404);
    } finally {
      await harness.close();
    }
  });
});

describe("streaming a run", () => {
  it("relays text, tool activity, usage, and completion in order", async () => {
    const harness = await serve(project("stream", { "notes.txt": "hi" }), [
      {
        turn(events) {
          events.onThinking?.("considering");
          events.onToolCall?.("read", { path: "notes.txt" });
          events.onToolResult?.("read", "hi", false);
          events.onText?.("Here is ");
          events.onText?.("what I found.");
        },
      },
    ]);
    try {
      const { sessionId } = await newSession(harness);
      const events = await chat(harness, sessionId, "what is in notes.txt?");

      assert.deepEqual(kinds(events), [
        "thinking", "tool", "tool_result", "text", "text", "usage", "usage", "done",
      ]);

      const tool = events.find((e) => e.type === "tool");
      assert.deepEqual(tool, { type: "tool", name: "read", detail: "notes.txt" });

      const text = events.filter((e) => e.type === "text").map((e) => e.text).join("");
      assert.equal(text, "Here is what I found.");

      const usage = events.find((e) => e.type === "usage");
      assert.ok(usage && usage.type === "usage");
      assert.equal(usage.cacheHitRate, 0.9);
    } finally {
      await harness.close();
    }
  });

  it("reports a failing tool call so the browser can show it", async () => {
    const harness = await serve(project("stream-toolfail", { "a.txt": "" }), [
      {
        turn(events) {
          events.onToolResult?.("edit", "Blocked: path escapes the project root", true);
        },
      },
    ]);
    try {
      const { sessionId } = await newSession(harness);
      const events = await chat(harness, sessionId, "edit /etc/passwd");
      const failure = events.find((e) => e.type === "tool_result");
      assert.ok(failure && failure.type === "tool_result");
      assert.equal(failure.ok, false);
      assert.match(failure.preview, /escapes the project root/);
    } finally {
      await harness.close();
    }
  });

  it("surfaces a degraded-feature notice rather than hiding it", async () => {
    const harness = await serve(project("stream-notice", { "a.txt": "" }), [
      { turn(events) { events.onNotice?.("Context editing is unavailable."); } },
    ]);
    try {
      const { sessionId } = await newSession(harness);
      const events = await chat(harness, sessionId, "go");
      const notice = events.find((e) => e.type === "notice");
      assert.ok(notice && notice.type === "notice");
      assert.match(notice.text, /Context editing/);
    } finally {
      await harness.close();
    }
  });

  it("refuses a second task while one is already running", async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const harness = await serve(project("stream-busy", { "a.txt": "" }), [
      { turn: () => blocked },
    ]);
    try {
      const { sessionId } = await newSession(harness);
      const first = chat(harness, sessionId, "long task");

      // Wait for the first request to be accepted and marked running.
      await new Promise((resolve) => setTimeout(resolve, 60));

      const second = await fetch(`${harness.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, task: "meanwhile" }),
      });
      assert.equal(second.status, 409);

      release();
      await first;
    } finally {
      await harness.close();
    }
  });
});

describe("modes", () => {
  it("read mode gives the agent a readonly config and nothing to verify", async () => {
    const root = project("mode-read", {
      "package.json": JSON.stringify({ scripts: { test: "node -e ''" } }),
    });
    const harness = await serve(root);
    try {
      const { sessionId } = await newSession(harness);
      const events = await chat(harness, sessionId, "explain this");

      const config = harness.record.configs[0];
      assert.ok(config);
      assert.equal(config.approval, "readonly");
      assert.equal(config.verify, false);
      // Nothing changed, so no check should have been run.
      assert.equal(kinds(events).includes("phase"), false);
    } finally {
      await harness.close();
    }
  });

  /**
   * `ask` needs a terminal to answer it, and a browser is not one — in `ask`
   * mode every write would be denied with no explanation. Build mode must
   * therefore pre-approve, and the page warns about it.
   */
  it("build mode pre-approves rather than falling back to a prompt nobody can answer", async () => {
    const root = project("mode-build", { "a.txt": "" });
    const harness = await serve(root);
    try {
      const settings: SessionSettings = { ...SETTINGS, mode: "build" };
      const { sessionId } = await newSession(harness, settings);
      await chat(harness, sessionId, "change something", settings);

      const config = harness.record.configs[0];
      assert.ok(config);
      assert.equal(config.approval, "auto");
      assert.notEqual(config.approval, "ask");
    } finally {
      await harness.close();
    }
  });

  it("build mode runs the project's checks and reports a green verdict", async () => {
    const root = project("mode-verify-pass", {
      "package.json": JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }),
    });
    const harness = await serve(root);
    try {
      const settings: SessionSettings = { ...SETTINGS, mode: "build" };
      const { sessionId } = await newSession(harness, settings);
      const events = await chat(harness, sessionId, "make a change", settings);

      assert.ok(kinds(events).includes("phase"), "verification phases should reach the browser");
      const done = events.find((e) => e.type === "done");
      assert.ok(done && done.type === "done");
      assert.equal(done.verdict, "verified");
    } finally {
      await harness.close();
    }
  });

  it("feeds a failing check back for repair and reports the outcome", async () => {
    const root = project("mode-verify-repair", {
      "package.json": JSON.stringify({
        scripts: {
          test: "node -e \"process.exit(require('fs').readFileSync('value.txt','utf8').trim()==='good'?0:1)\"",
        },
      }),
      "value.txt": "good\n",
    });
    const value = path.join(root, "value.txt");

    const harness = await serve(root, [
      // First turn breaks a check that was green; the repair turn fixes it.
      { turn: () => { fs.writeFileSync(value, "bad\n"); } },
      { turn: () => { fs.writeFileSync(value, "good\n"); } },
    ]);
    try {
      const settings: SessionSettings = { ...SETTINGS, mode: "build" };
      const { sessionId } = await newSession(harness, settings);
      const events = await chat(harness, sessionId, "change the value", settings);

      const done = events.find((e) => e.type === "done");
      assert.ok(done && done.type === "done");
      assert.equal(done.verdict, "verified");
      assert.match(done.summary, /1 repair round/);

      // The repair prompt is a second run against the same agent.
      assert.equal(harness.record.tasks.length, 2);
      assert.match(harness.record.tasks[1]!, /Verification failed/);
    } finally {
      await harness.close();
    }
  });

  it("reports a check it could not repair instead of claiming success", async () => {
    const root = project("mode-verify-fail", {
      "package.json": JSON.stringify({
        scripts: {
          test: "node -e \"process.exit(require('fs').readFileSync('value.txt','utf8').trim()==='good'?0:1)\"",
        },
      }),
      "value.txt": "good\n",
    });

    const harness = await serve(root, [
      { turn: () => { fs.writeFileSync(path.join(root, "value.txt"), "bad\n"); } },
    ]);
    try {
      const settings: SessionSettings = { ...SETTINGS, mode: "build" };
      const { sessionId } = await newSession(harness, settings);
      const events = await chat(harness, sessionId, "break it", settings);

      const done = events.find((e) => e.type === "done");
      assert.ok(done && done.type === "done");
      assert.equal(done.verdict, "regressed");
      assert.match(done.summary, /NOT verified/);
    } finally {
      await harness.close();
    }
  });

  it("skips verification when the operator turned it off", async () => {
    const root = project("mode-noverify", {
      "package.json": JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }),
    });
    const harness = await serve(root);
    try {
      const settings: SessionSettings = { ...SETTINGS, mode: "build", verify: false };
      const { sessionId } = await newSession(harness, settings);
      const events = await chat(harness, sessionId, "do it", settings);

      const done = events.find((e) => e.type === "done");
      assert.ok(done && done.type === "done");
      assert.equal(done.verdict, null);
      assert.equal(kinds(events).includes("phase"), false);
    } finally {
      await harness.close();
    }
  });
});

describe("conversation continuity", () => {
  it("reuses one agent across messages, so history and the prompt cache survive", async () => {
    const harness = await serve(project("continuity", { "a.txt": "" }), [
      { turn() {} },
      { turn() {} },
    ]);
    try {
      const { sessionId } = await newSession(harness);
      await chat(harness, sessionId, "first");
      await chat(harness, sessionId, "second");

      assert.equal(harness.record.configs.length, 1, "a second agent would re-send the whole history uncached");
      assert.deepEqual(harness.record.tasks, ["first", "second"]);
    } finally {
      await harness.close();
    }
  });

  it("starts a fresh conversation when the model changes, and says so", async () => {
    const harness = await serve(project("continuity-model", { "a.txt": "" }), [
      { turn() {} },
      { turn() {} },
    ]);
    try {
      const { sessionId } = await newSession(harness);
      await chat(harness, sessionId, "first");
      const events = await chat(harness, sessionId, "second", {
        ...SETTINGS,
        model: "claude-haiku-4-5",
      });

      assert.equal(harness.record.configs.length, 2);
      assert.equal(harness.record.configs[1]!.model, "claude-haiku-4-5");
      const notice = events.find((e) => e.type === "notice");
      assert.ok(notice && notice.type === "notice");
      assert.match(notice.text, /fresh conversation/);
    } finally {
      await harness.close();
    }
  });

  it("starts a fresh conversation when the mode changes", async () => {
    const harness = await serve(project("continuity-mode", { "a.txt": "" }), [
      { turn() {} },
      { turn() {} },
    ]);
    try {
      const { sessionId } = await newSession(harness);
      await chat(harness, sessionId, "first");
      await chat(harness, sessionId, "second", { ...SETTINGS, mode: "build" });

      assert.equal(harness.record.configs.length, 2);
      assert.equal(harness.record.configs[1]!.approval, "auto");
    } finally {
      await harness.close();
    }
  });

  it("keeps the conversation when only effort changes", async () => {
    const harness = await serve(project("continuity-effort", { "a.txt": "" }), [
      { turn() {} },
      { turn() {} },
    ]);
    try {
      const { sessionId } = await newSession(harness);
      await chat(harness, sessionId, "first");
      await chat(harness, sessionId, "second", { ...SETTINGS, effort: "low" });
      assert.equal(harness.record.configs.length, 1);
    } finally {
      await harness.close();
    }
  });

  it("ignores a model the server does not know instead of forwarding it", async () => {
    const harness = await serve(project("continuity-bogus", { "a.txt": "" }), [{ turn() {} }]);
    try {
      const { sessionId } = await newSession(harness);
      await chat(harness, sessionId, "go", { ...SETTINGS, model: "gpt-9-ultra" });
      assert.equal(harness.record.configs[0]!.model, DEFAULT_CONFIG.model);
    } finally {
      await harness.close();
    }
  });

  it("forwards a dated snapshot rather than silently substituting the default", async () => {
    // The dated id is the canonical one. Validating it by exact catalogue key
    // sent it down the unknown-model path above, so asking for Haiku quietly
    // ran — and billed — whatever the default model was.
    const harness = await serve(project("continuity-dated", { "a.txt": "" }), [{ turn() {} }]);
    try {
      const { sessionId } = await newSession(harness);
      await chat(harness, sessionId, "go", { ...SETTINGS, model: "claude-haiku-4-5-20251001" });
      assert.equal(harness.record.configs[0]!.model, "claude-haiku-4-5-20251001");
      assert.notEqual(harness.record.configs[0]!.model, DEFAULT_CONFIG.model);
    } finally {
      await harness.close();
    }
  });
});

describe("session store", () => {
  it("drops idle sessions but keeps busy ones", async () => {
    const store = new SessionStore();
    const idle = store.create(workspace, SETTINGS);
    assert.equal(store.size, 1);

    assert.equal(store.evictIdle(60_000), 0, "a fresh session is not idle");
    assert.equal(store.evictIdle(-1), 1, "an idle session is dropped");
    assert.equal(store.get(idle.id), undefined);
  });

  it("hands back the session it created", () => {
    const store = new SessionStore();
    const session = store.create(workspace, SETTINGS);
    assert.equal(store.get(session.id), session);
    assert.equal(store.delete(session.id), true);
    assert.equal(store.delete(session.id), false);
  });
});

describe("tool call descriptions", () => {
  it("names the file for file tools", () => {
    assert.equal(describeToolCall("read", { path: "src/a.ts" }), "src/a.ts");
    assert.equal(describeToolCall("edit", { path: "src/b.ts", old_string: "x", new_string: "y" }), "src/b.ts");
  });

  it("shows the command for bash and the pattern for search", () => {
    assert.equal(describeToolCall("bash", { command: "npm test" }), "npm test");
    assert.equal(describeToolCall("glob", { pattern: "**/*.ts" }), "**/*.ts");
    assert.equal(describeToolCall("grep", { pattern: "TODO", path: "src" }), "TODO in src");
    assert.equal(describeToolCall("grep", { pattern: "TODO" }), "TODO");
  });

  it("truncates an unknown tool's input rather than flooding the transcript", () => {
    const detail = describeToolCall("mystery", { blob: "x".repeat(500) });
    assert.ok(detail.length <= 121, `expected a short summary, got ${detail.length} characters`);
  });

  it("does not fabricate a description from a missing field", () => {
    assert.equal(describeToolCall("read", {}), "");
  });
});

describe("session errors", () => {
  it("turns an agent crash into an error event instead of a dropped stream", async () => {
    const session = new Session(workspace, SETTINGS, () => ({
      costMeter: new CostMeter(DEFAULT_CONFIG.model),
      run() { throw new Error("model exploded"); },
    }));

    const events: WebEvent[] = [];
    await session.send("go", (event) => events.push(event));

    const error = events.find((e) => e.type === "error");
    assert.ok(error && error.type === "error");
    assert.match(error.message, /model exploded/);
    assert.equal(session.busy, false, "a crashed run must not leave the session wedged");
  });

  it("rejects overlapping sends at the session level too", async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const session = new Session(workspace, SETTINGS, () => ({
      costMeter: new CostMeter(DEFAULT_CONFIG.model),
      async run(): Promise<RunResult> {
        await blocked;
        return {
          finalText: "",
          turns: 1,
          stoppedBecause: "completed",
          meter: new CostMeter(DEFAULT_CONFIG.model),
        };
      },
    }));

    const first = session.send("one", () => {});
    const events: WebEvent[] = [];
    await session.send("two", (event) => events.push(event));

    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "error");

    release();
    await first;
  });
});
