/**
 * Integration test for the agent loop, driven by a mock Messages endpoint.
 *
 * A live API key would test the model; this tests the harness, which is the
 * part that can be wrong in ways a model never fixes: request shape, SSE
 * parsing, tool dispatch, message threading, and cache-breakpoint placement.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import { Agent } from "../src/agent.js";
import { DEFAULT_CONFIG, type AgentConfig } from "../src/config.js";

interface CapturedRequest {
  body: Record<string, any>;
  betas: string[];
}

let server: http.Server;
let baseUrl: string;
let root: string;
let captured: CapturedRequest[] = [];
/** Queue of SSE bodies; each request shifts one off. */
let responses: string[] = [];

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function messageStart(usage: Record<string, number>) {
  return [
    "message_start",
    {
      type: "message_start",
      message: {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    },
  ] as [string, unknown];
}

function textBlock(index: number, text: string): Array<[string, unknown]> {
  return [
    ["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index }],
  ];
}

function toolUseBlock(index: number, id: string, name: string, input: unknown): Array<[string, unknown]> {
  return [
    [
      "content_block_start",
      { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index }],
  ];
}

function finish(stopReason: string, outputTokens: number): Array<[string, unknown]> {
  return [
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...DEFAULT_CONFIG, root, approval: "auto", maxTurns: 8, ...overrides };
}

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dhozzi-loop-")));
  fs.writeFileSync(path.join(root, "hello.txt"), "line one\nline two\n");

  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      captured.push({
        body: JSON.parse(raw || "{}"),
        betas: String(req.headers["anthropic-beta"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      });
      const body = responses.shift();
      if (body === undefined) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "mock queue empty" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  // Not a credential — the mock server never checks it, and it is deliberately
  // not key-shaped so secret scanners do not flag this file.
  process.env["ANTHROPIC_API_KEY"] = "mock-value-for-tests";
  process.env["ANTHROPIC_BASE_URL"] = baseUrl;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

function reset(): void {
  captured = [];
  responses = [];
}

describe("agent loop", () => {
  it("calls a tool, feeds the result back, and finishes on end_turn", async () => {
    reset();
    responses = [
      sse([
        messageStart({ input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 40, cache_read_input_tokens: 0 }),
        ...textBlock(0, "Reading the file."),
        ...toolUseBlock(1, "toolu_1", "read", { path: "hello.txt" }),
        ...finish("tool_use", 30),
      ]),
      sse([
        messageStart({ input_tokens: 20, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 140 }),
        ...textBlock(0, "The file has two lines."),
        ...finish("end_turn", 12),
      ]),
    ];

    const toolCalls: string[] = [];
    const agent = new Agent(makeConfig(), { onToolCall: (name) => toolCalls.push(name) });
    const result = await agent.run("How many lines are in hello.txt?");

    assert.equal(result.stoppedBecause, "completed");
    assert.equal(result.finalText, "The file has two lines.");
    assert.deepEqual(toolCalls, ["read"]);
    assert.equal(captured.length, 2);

    // The second request must carry the assistant turn plus a matching
    // tool_result, or the API would reject it for an unpaired tool_use.
    const second = captured[1]!.body;
    assert.equal(second["messages"].length, 3);
    assert.equal(second["messages"][1].role, "assistant");
    const toolResult = second["messages"][2].content[0];
    assert.equal(toolResult.type, "tool_result");
    assert.equal(toolResult.tool_use_id, "toolu_1");
    assert.equal(toolResult.is_error, false);
    assert.match(toolResult.content, /line one/);
  });

  it("meters tokens and cost across turns", async () => {
    reset();
    responses = [
      sse([
        messageStart({ input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 40, cache_read_input_tokens: 0 }),
        ...toolUseBlock(0, "toolu_1", "read", { path: "hello.txt" }),
        ...finish("tool_use", 30),
      ]),
      sse([
        messageStart({ input_tokens: 20, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 140 }),
        ...textBlock(0, "done"),
        ...finish("end_turn", 12),
      ]),
    ];

    const agent = new Agent(makeConfig());
    await agent.run("read it");
    const meter = agent.costMeter;

    assert.equal(meter.turns, 2);
    assert.equal(meter.cacheRead, 140);
    assert.equal(meter.cacheWrite, 40);
    assert.equal(meter.totalInput, 300);
    assert.equal(meter.output, 42);
    assert.ok(meter.costUsd! > 0);
    assert.ok(meter.costWithoutCachingUsd! > meter.costUsd!);
  });

  it("places cache breakpoints on the system prompt and the last two user turns", async () => {
    reset();
    responses = [
      sse([
        messageStart({ input_tokens: 10, output_tokens: 1 }),
        ...toolUseBlock(0, "toolu_1", "read", { path: "hello.txt" }),
        ...finish("tool_use", 5),
      ]),
      sse([
        messageStart({ input_tokens: 10, output_tokens: 1 }),
        ...toolUseBlock(0, "toolu_2", "read", { path: "hello.txt" }),
        ...finish("tool_use", 5),
      ]),
      sse([messageStart({ input_tokens: 10, output_tokens: 1 }), ...textBlock(0, "ok"), ...finish("end_turn", 3)]),
    ];

    const agent = new Agent(makeConfig());
    await agent.run("read it twice");

    const third = captured[2]!.body;
    assert.equal(third["system"][0].cache_control.type, "ephemeral");

    const userMessages = third["messages"].filter((m: any) => m.role === "user");
    assert.equal(userMessages.length, 3);
    const marked = (m: any) => m.content.some((b: any) => b.cache_control !== undefined);

    // Exactly the two most recent user turns are marked; older ones are
    // cleared so the request never exceeds the four-breakpoint limit.
    assert.equal(marked(userMessages[0]), false);
    assert.equal(marked(userMessages[1]), true);
    assert.equal(marked(userMessages[2]), true);

    const breakpoints = JSON.stringify(third).split('"cache_control"').length - 1;
    assert.ok(breakpoints <= 4, `expected at most 4 breakpoints, found ${breakpoints}`);
  });

  it("sends adaptive thinking, effort, and the expected betas", async () => {
    reset();
    responses = [
      sse([messageStart({ input_tokens: 10, output_tokens: 1 }), ...textBlock(0, "hi"), ...finish("end_turn", 2)]),
    ];

    const agent = new Agent(makeConfig({ effort: "xhigh", taskBudget: 50_000 }));
    await agent.run("hello");

    const body = captured[0]!.body;
    assert.equal(body["thinking"].type, "adaptive");
    assert.equal(body["output_config"].effort, "xhigh");
    assert.deepEqual(body["output_config"].task_budget, { type: "tokens", total: 50_000 });
    assert.equal(body["fallbacks"], "default");
    assert.deepEqual(body["context_management"], { edits: [{ type: "clear_tool_uses_20250919" }] });

    const betas = captured[0]!.betas;
    assert.ok(betas.includes("context-management-2025-06-27"));
    assert.ok(betas.includes("task-budgets-2026-03-13"));
    assert.ok(betas.includes("server-side-fallback-2026-07-01"));

    // Sampling parameters were removed on this model family and would 400.
    assert.equal(body["temperature"], undefined);
    assert.equal(body["top_p"], undefined);
    assert.equal(body["top_k"], undefined);
  });

  it("omits thinking, effort, budget, and fallback on a model that rejects them", async () => {
    reset();
    responses = [
      sse([messageStart({ input_tokens: 10, output_tokens: 1 }), ...textBlock(0, "hi"), ...finish("end_turn", 2)]),
    ];

    // Haiku 4.5 predates adaptive thinking and the effort parameter; sending
    // either is a 400 rather than a silently ignored field.
    const agent = new Agent(makeConfig({ model: "claude-haiku-4-5", taskBudget: 50_000 }));
    await agent.run("hello");

    const body = captured[0]!.body;
    assert.equal(body["model"], "claude-haiku-4-5");
    assert.equal(body["thinking"], undefined);
    assert.equal(body["output_config"], undefined);
    assert.equal(body["fallbacks"], undefined);

    const betas = captured[0]!.betas;
    assert.equal(betas.includes("task-budgets-2026-03-13"), false);
    assert.equal(betas.includes("server-side-fallback-2026-07-01"), false);
    // Context editing is model-agnostic, so it stays on.
    assert.ok(betas.includes("context-management-2025-06-27"));
  });

  it("keeps server-side fallback off for models that do not list it", async () => {
    reset();
    responses = [
      sse([messageStart({ input_tokens: 10, output_tokens: 1 }), ...textBlock(0, "hi"), ...finish("end_turn", 2)]),
    ];

    const agent = new Agent(makeConfig({ model: "claude-sonnet-5" }));
    await agent.run("hello");

    const body = captured[0]!.body;
    assert.equal(body["fallbacks"], undefined);
    // Sonnet 5 does support adaptive thinking and effort.
    assert.equal(body["thinking"].type, "adaptive");
    assert.equal(body["output_config"].effort, "high");
  });

  it("omits optional features when they are switched off", async () => {
    reset();
    responses = [
      sse([messageStart({ input_tokens: 10, output_tokens: 1 }), ...textBlock(0, "hi"), ...finish("end_turn", 2)]),
    ];

    const agent = new Agent(
      makeConfig({ promptCaching: false, contextEditing: false, refusalFallback: false }),
    );
    await agent.run("hello");

    const body = captured[0]!.body;
    assert.equal(body["context_management"], undefined);
    assert.equal(body["fallbacks"], undefined);
    assert.equal(body["system"][0].cache_control, undefined);
    assert.equal(JSON.stringify(body).includes("cache_control"), false);
  });

  it("stops on a refusal without treating the empty content as an answer", async () => {
    reset();
    responses = [
      sse([
        messageStart({ input_tokens: 10, output_tokens: 0 }),
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: "refusal", stop_sequence: null },
            usage: { output_tokens: 0 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ]),
    ];

    const agent = new Agent(makeConfig());
    const result = await agent.run("something declined");

    assert.equal(result.stoppedBecause, "refusal");
    assert.match(result.finalText, /declined/);
  });

  it("reports the output cap instead of silently returning a truncated answer", async () => {
    reset();
    responses = [
      sse([
        messageStart({ input_tokens: 10, output_tokens: 1 }),
        ...textBlock(0, "a partial ans"),
        ...finish("max_tokens", 64_000),
      ]),
    ];

    const agent = new Agent(makeConfig());
    const result = await agent.run("write something enormous");

    assert.equal(result.stoppedBecause, "max_tokens");
    assert.match(result.finalText, /--max-tokens/);
  });

  it("returns a tool_result even when the tool fails, so the pairing holds", async () => {
    reset();
    responses = [
      sse([
        messageStart({ input_tokens: 10, output_tokens: 1 }),
        ...toolUseBlock(0, "toolu_bad", "read", { path: "../../etc/passwd" }),
        ...finish("tool_use", 5),
      ]),
      sse([
        messageStart({ input_tokens: 10, output_tokens: 1 }),
        ...textBlock(0, "I cannot reach that path."),
        ...finish("end_turn", 4),
      ]),
    ];

    const agent = new Agent(makeConfig());
    const result = await agent.run("read the password file");

    assert.equal(result.stoppedBecause, "completed");
    const blocked = captured[1]!.body["messages"][2].content[0];
    assert.equal(blocked.type, "tool_result");
    assert.equal(blocked.tool_use_id, "toolu_bad");
    assert.equal(blocked.is_error, true);
    assert.match(blocked.content, /Blocked|escapes/);
  });

  it("stops at the turn limit rather than looping forever", async () => {
    reset();
    const loopTurn = sse([
      messageStart({ input_tokens: 10, output_tokens: 1 }),
      ...toolUseBlock(0, "toolu_x", "read", { path: "hello.txt" }),
      ...finish("tool_use", 5),
    ]);
    responses = Array.from({ length: 6 }, () => loopTurn);

    const agent = new Agent(makeConfig({ maxTurns: 3 }));
    const result = await agent.run("loop forever");

    assert.equal(result.stoppedBecause, "max_turns");
    assert.equal(result.turns, 3);
    assert.equal(captured.length, 3);
  });

  it("resumes a paused server-tool turn without inserting a user message", async () => {
    reset();
    responses = [
      sse([
        messageStart({ input_tokens: 10, output_tokens: 1 }),
        ...textBlock(0, "searching"),
        ...finish("pause_turn", 5),
      ]),
      sse([
        messageStart({ input_tokens: 10, output_tokens: 1 }),
        ...textBlock(0, "found it"),
        ...finish("end_turn", 4),
      ]),
    ];

    const agent = new Agent(makeConfig({ webTools: true }));
    const result = await agent.run("look something up");

    assert.equal(result.stoppedBecause, "completed");
    assert.equal(result.finalText, "found it");
    const second = captured[1]!.body;
    assert.equal(second["messages"].length, 2);
    assert.equal(second["messages"][1].role, "assistant");
  });

  it("keeps history across runs so the cached prefix survives a follow-up", async () => {
    reset();
    responses = [
      sse([messageStart({ input_tokens: 10, output_tokens: 1 }), ...textBlock(0, "first"), ...finish("end_turn", 2)]),
      sse([messageStart({ input_tokens: 10, output_tokens: 1 }), ...textBlock(0, "second"), ...finish("end_turn", 2)]),
    ];

    const agent = new Agent(makeConfig());
    await agent.run("one");
    await agent.run("two");

    const second = captured[1]!.body;
    assert.equal(second["messages"].length, 3);
    // The environment preamble is attached once, to the opening turn only.
    assert.match(second["messages"][0].content[0].text, /<environment>/);
    assert.equal(second["messages"][2].content[0].text, "two");
  });
});
