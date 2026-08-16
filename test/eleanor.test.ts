/**
 * Tests for Eleanor's harness pieces: the compare_options tool in isolation,
 * and — driven by the same mock-Messages-endpoint technique as loop.test.ts —
 * the parts of agent.ts that only Eleanor exercises: a swapped persona
 * actually reaching the request, an image landing in the message content
 * instead of going through a tool, a tool's `card` surfacing via onToolCard
 * without leaking into what the model sees, and setEvents actually rebinding
 * mid-session rather than a session being stuck on its first caller's
 * callbacks.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { Agent, type AgentPersona } from "../src/agent.js";
import { DEFAULT_CONFIG, type AgentConfig } from "../src/config.js";
import { ELEANOR_TOOLS } from "../src/eleanor/tools.js";
import { EleanorSessionStore, SessionBusyError } from "../src/eleanor/sessions.js";

// -- compare_options, unit-level -------------------------------------------

const compareOptionsTool = ELEANOR_TOOLS.find((t) => t.name === "compare_options")!;

async function run(input: Record<string, unknown>) {
  return compareOptionsTool.run(input, { config: {} as AgentConfig, readFiles: new Map() });
}

describe("compare_options", () => {
  it("builds a card from two well-formed options", async () => {
    const result = await run({
      options: [
        { label: "Black felt Akubra", price: "$249", reason: "Suits her colouring and the denim jacket she wears." },
        { label: "Fawn suede Akubra", imageUrl: "https://example.com/a.jpg", reason: "Lighter, better for the trip she mentioned." },
      ],
    });

    assert.equal(result.isError, false);
    assert.equal(result.card?.["type"], "compare_options");
    const options = result.card?.["options"] as unknown[];
    assert.equal(options.length, 2);
    assert.match(result.content, /Black felt Akubra/);
  });

  it("rejects fewer than two options", async () => {
    const result = await run({ options: [{ label: "Only one", reason: "n/a" }] });
    assert.equal(result.isError, true);
    assert.equal(result.card, undefined);
  });

  it("rejects more than three options", async () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ label: `Option ${i}`, reason: "filler" }));
    const result = await run({ options: four });
    assert.equal(result.isError, true);
  });

  it("requires a reason, not just a label", async () => {
    const result = await run({
      options: [{ label: "A", reason: "good fit" }, { label: "B" }],
    });
    assert.equal(result.isError, true);
    assert.match(result.content, /reason/);
  });

  it("requires options to be an array at all", async () => {
    const result = await run({ options: "not an array" });
    assert.equal(result.isError, true);
  });

  it("drops empty optional fields rather than passing them through", async () => {
    const result = await run({
      options: [
        { label: "A", reason: "fits", price: "", imageUrl: "" },
        { label: "B", reason: "also fits" },
      ],
    });
    const options = result.card?.["options"] as Record<string, unknown>[];
    assert.equal("price" in options[0]!, false);
    assert.equal("imageUrl" in options[0]!, false);
  });
});

// -- integration: persona, images, cards, event rebinding -------------------

let server: http.Server;
let baseUrl: string;
let captured: { body: Record<string, any> }[] = [];
let responses: string[] = [];

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function messageStart(usage: Record<string, number> = { input_tokens: 10, output_tokens: 1 }) {
  return [
    "message_start",
    { type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, stop_sequence: null, usage } },
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
    ["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
    ["content_block_stop", { type: "content_block_stop", index }],
  ];
}

function finish(stopReason: string, outputTokens = 1): Array<[string, unknown]> {
  return [
    ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } }],
    ["message_stop", { type: "message_stop" }],
  ];
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...DEFAULT_CONFIG, root: "/tmp", approval: "auto", maxTurns: 8, ...overrides };
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      captured.push({ body: JSON.parse(raw || "{}") });
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
  process.env["ANTHROPIC_API_KEY"] = "mock-value-for-tests";
  process.env["ANTHROPIC_BASE_URL"] = baseUrl;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function reset(): void {
  captured = [];
  responses = [];
}

describe("persona parameterization", () => {
  it("sends the persona's system prompt and tool set, not the coding harness's", async () => {
    reset();
    responses = [sse([messageStart(), ...textBlock(0, "hello"), ...finish("end_turn")])];

    const persona: AgentPersona = {
      systemPrompt: "You are a test persona, distinguishable from the coding one.",
      tools: ELEANOR_TOOLS,
    };
    const agent = new Agent(makeConfig(), {}, persona);
    await agent.run("hi");

    const sent = captured[0]!.body;
    const systemText = sent["system"][0].text as string;
    assert.match(systemText, /test persona/);
    assert.doesNotMatch(systemText, /coding agent/);
    const toolNames = (sent["tools"] as { name: string }[]).map((t) => t.name);
    assert.deepEqual(toolNames, ["compare_options"]);
  });
});

describe("vision content", () => {
  it("places an image block ahead of the text block, not through a tool", async () => {
    reset();
    responses = [sse([messageStart(), ...textBlock(0, "I can see it."), ...finish("end_turn")])];

    const agent = new Agent(makeConfig(), {}, { systemPrompt: "x", tools: [] });
    await agent.run({ text: "what is this?", images: [{ data: "ZmFrZQ==", mediaType: "image/png" }] });

    const content = captured[0]!.body["messages"][0].content;
    assert.equal(content[0].type, "image");
    assert.equal(content[0].source.media_type, "image/png");
    assert.equal(content[0].source.data, "ZmFrZQ==");
    assert.equal(content[1].type, "text");
    assert.match(content[1].text, /what is this\?/);
  });
});

describe("onToolCard", () => {
  it("fires with the tool's card and never leaks the card into the model-facing content", async () => {
    reset();
    responses = [
      sse([
        messageStart(),
        ...toolUseBlock(0, "toolu_1", "compare_options", {
          options: [
            { label: "A", reason: "fits" },
            { label: "B", reason: "also fits" },
          ],
        }),
        ...finish("tool_use", 5),
      ]),
      sse([messageStart(), ...textBlock(0, "Here are two."), ...finish("end_turn")]),
    ];

    const cards: Record<string, unknown>[] = [];
    const agent = new Agent(makeConfig(), { onToolCard: (_name, card) => cards.push(card) }, {
      systemPrompt: "x",
      tools: ELEANOR_TOOLS,
    });
    await agent.run("compare two hats");

    assert.equal(cards.length, 1);
    assert.equal(cards[0]!["type"], "compare_options");

    // The second request's tool_result content is what the model actually
    // sees — it must be prose, not the structured card re-serialized.
    // messages: [user, assistant(tool_use), user(tool_result)] — index 2.
    const toolResultContent = captured[1]!.body["messages"][2].content[0].content as string;
    assert.doesNotMatch(toolResultContent, /"type":"compare_options"/);
    assert.match(toolResultContent, /Presented 2 options/);
  });

  it("does not fire onToolCard for a failed tool call", async () => {
    reset();
    responses = [
      sse([
        messageStart(),
        ...toolUseBlock(0, "toolu_1", "compare_options", { options: [{ label: "only one", reason: "x" }] }),
        ...finish("tool_use", 5),
      ]),
      sse([messageStart(), ...textBlock(0, "Couldn't compare those."), ...finish("end_turn")]),
    ];

    const cards: Record<string, unknown>[] = [];
    const agent = new Agent(makeConfig(), { onToolCard: (_name, card) => cards.push(card) }, {
      systemPrompt: "x",
      tools: ELEANOR_TOOLS,
    });
    await agent.run("compare one hat");

    assert.equal(cards.length, 0);
  });
});

describe("setEvents", () => {
  it("rebinds callbacks so a second run uses the new caller's events, not the first's", async () => {
    reset();
    responses = [
      sse([messageStart(), ...textBlock(0, "first reply"), ...finish("end_turn")]),
      sse([messageStart(), ...textBlock(0, "second reply"), ...finish("end_turn")]),
    ];

    const firstSeen: string[] = [];
    const secondSeen: string[] = [];
    const agent = new Agent(makeConfig(), { onText: (t) => firstSeen.push(t) }, { systemPrompt: "x", tools: [] });

    await agent.run("one");
    agent.setEvents({ onText: (t) => secondSeen.push(t) });
    await agent.run("two");

    assert.equal(firstSeen.join(""), "first reply");
    assert.equal(secondSeen.join(""), "second reply");
  });
});

describe("EleanorSessionStore", () => {
  it("reuses the same agent for a returning user, keeping conversation history", async () => {
    reset();
    responses = [
      sse([messageStart(), ...textBlock(0, "first reply"), ...finish("end_turn")]),
      sse([messageStart(), ...textBlock(0, "second reply"), ...finish("end_turn")]),
    ];

    const store = new EleanorSessionStore();
    await store.send("user-1", {}, (agent) => agent.run("first message"));
    await store.send("user-1", {}, (agent) => agent.run("second message"));

    // A fresh agent would send only the new message; a reused one carries
    // the prior turn along too — [user, assistant, user] proves continuity.
    const second = captured[1]!.body;
    assert.equal(second["messages"].length, 3);
    assert.match(JSON.stringify(second["messages"][0]), /first message/);
  });

  it("gives a different user their own agent, with no shared history", async () => {
    reset();
    responses = [
      sse([messageStart(), ...textBlock(0, "reply to A"), ...finish("end_turn")]),
      sse([messageStart(), ...textBlock(0, "reply to B"), ...finish("end_turn")]),
    ];

    const store = new EleanorSessionStore();
    await store.send("user-a", {}, (agent) => agent.run("hello from A"));
    await store.send("user-b", {}, (agent) => agent.run("hello from B"));

    const second = captured[1]!.body;
    assert.equal(second["messages"].length, 1);
    assert.doesNotMatch(JSON.stringify(second["messages"]), /hello from A/);
  });

  it("rejects a second send while the first is still running", async () => {
    reset();
    responses = [sse([messageStart(), ...textBlock(0, "done"), ...finish("end_turn")])];

    const store = new EleanorSessionStore();
    const first = store.send("user-1", {}, (agent) => agent.run("first"));
    await assert.rejects(
      () => store.send("user-1", {}, (agent) => agent.run("second")),
      SessionBusyError,
    );
    await first;
  });

  it("evicts an idle session so the next message starts fresh", async () => {
    reset();
    responses = [
      sse([messageStart(), ...textBlock(0, "first reply"), ...finish("end_turn")]),
      sse([messageStart(), ...textBlock(0, "second reply"), ...finish("end_turn")]),
    ];

    const store = new EleanorSessionStore({}, 10); // 10ms idle timeout
    await store.send("user-1", {}, (agent) => agent.run("first message"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await store.send("user-1", {}, (agent) => agent.run("second message"));

    const second = captured[1]!.body;
    assert.equal(second["messages"].length, 1, "eviction should have started a fresh agent");
  });
});
