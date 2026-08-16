/**
 * The agent loop.
 *
 * This is a hand-written loop rather than the SDK's tool runner because the
 * harness needs to interleave work the runner does not own: placing cache
 * breakpoints on the message array each turn, metering spend, gating mutating
 * tools behind operator approval, and degrading beta features when an account
 * lacks them.
 */

import Anthropic from "@anthropic-ai/sdk";
import { BETAS, capabilitiesFor, type AgentConfig, type ModelCapabilities } from "./config.js";
import { CostMeter } from "./cost.js";
import { TOOLS, type ToolContext, type ToolDefinition } from "./tools.js";
import { SafetyError } from "./safety.js";

/**
 * Kept byte-identical across every run so the cached prefix is reusable
 * between sessions. Anything session-specific (cwd, dates, task text) goes in
 * the first user message instead — interpolating it here would move the cache
 * boundary to the front of the prompt and make every request a cache miss.
 */
const SYSTEM_PROMPT = `You are a coding agent working in a real repository through tools.

## How to work

Read before you write. Locate the relevant code with glob and grep rather than
guessing at paths, and read a file before editing it — edits to unread files are
rejected by the harness.

Prefer edit over write. A targeted replacement is cheaper, easier to review, and
cannot silently drop the rest of the file.

Make independent tool calls in the same turn. Reading four files or grepping for
three symbols should be one turn, not four.

Verify your work. When the project has tests, a type checker, or a linter, run
them after a change and report what they said. If something fails, say so and
show the output rather than describing the change as complete.

Match the surrounding code. Follow the file's existing naming, formatting, and
idiom instead of importing conventions from elsewhere. Write a comment only to
record a constraint the code cannot express on its own.

## Scope

Deliver what was asked, at the scope intended. Make routine judgment calls
yourself; check in only when different readings would lead to materially
different work. If you think the request is mistaken or a better approach
exists, say so in a sentence and continue with the task as asked — do not
quietly widen, narrow, or transform it. Do not add features, abstractions,
error handling for impossible states, or defensive scaffolding beyond what the
task requires.

Finish the whole task, not the easy part of it. Report completion only when the
work is actually done; if you genuinely cannot finish something, do the rest and
state plainly what is missing and why.

## Communicating

Your text between tool calls is what the operator reads; they cannot see your
reasoning or the raw tool output. Before your first tool call, say in one
sentence what you are about to do. While working, speak up when you find
something load-bearing or change direction — not to narrate routine actions.

Lead with the outcome. Your final message should open with what happened or what
you found, then supporting detail. Write it for someone who stepped away and did
not watch the run: complete sentences, terms spelled out, no arrow chains or
shorthand you invented along the way. Being readable matters more than being
brief.

Report outcomes faithfully. If tests fail, say so with the output. If you
skipped a step, say that. When something is done and verified, state it plainly
without hedging.`;

/**
 * What makes an Agent instance a particular product rather than another.
 * The coding harness and Eleanor are the same loop, cache discipline, and
 * degrade-on-400 behavior underneath — only the system prompt and the tool
 * surface differ, so that's all a persona is.
 */
export interface AgentPersona {
  systemPrompt: string;
  tools: readonly ToolDefinition[];
}

export const CODING_PERSONA: AgentPersona = {
  systemPrompt: SYSTEM_PROMPT,
  tools: TOOLS,
};

export interface RunResult {
  finalText: string;
  turns: number;
  stoppedBecause: "completed" | "max_turns" | "refusal" | "max_tokens" | "error";
  meter: CostMeter;
}

export interface AgentEvents {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string, isError: boolean) => void;
  /**
   * Fired alongside onToolResult when a tool attaches structured data meant
   * for a UI to render (Eleanor's comparison cards, for instance). Never sent
   * to the model — that stays prose-only via onToolResult's `result` string —
   * this is purely a side channel for a consumer that wants richer output
   * than text. Coding tools never set this, so it's a no-op for Chai-Kan.
   */
  onToolCard?: (name: string, card: Record<string, unknown>) => void;
  onTurnEnd?: (meter: CostMeter) => void;
  onNotice?: (message: string) => void;
}

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** A turn's input: text, optionally with images (vision, not a tool call). */
export interface RunInput {
  text: string;
  images?: readonly { data: string; mediaType: ImageMediaType }[];
}

type Message = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

/**
 * Request features that can be dropped and retried if the account or model
 * turns out not to accept them. The static capability table covers the known
 * models; this is the net for everything else.
 */
type Degradable =
  | "contextEditing"
  | "taskBudget"
  | "refusalFallback"
  | "adaptiveThinking"
  | "effort";

export class Agent {
  private readonly client: Anthropic;
  private readonly config: AgentConfig;
  private events: AgentEvents;
  private readonly meter: CostMeter;
  private readonly toolContext: ToolContext;
  private readonly messages: Message[] = [];
  private readonly disabled = new Set<Degradable>();
  private readonly capabilities: ModelCapabilities;
  private readonly persona: AgentPersona;
  private readonly toolsByName: ReadonlyMap<string, ToolDefinition>;

  constructor(config: AgentConfig, events: AgentEvents = {}, persona: AgentPersona = CODING_PERSONA) {
    this.config = config;
    this.events = events;
    this.persona = persona;
    this.toolsByName = new Map(persona.tools.map((tool) => [tool.name, tool]));
    this.client = new Anthropic();
    this.meter = new CostMeter(config.model);
    this.capabilities = capabilitiesFor(config.model);
    this.toolContext = {
      config,
      readFiles: new Map(),
      onNotice: events.onNotice,
    };

    if (!config.contextEditing) this.disabled.add("contextEditing");
    if (config.taskBudget === null) this.disabled.add("taskBudget");
    if (!config.refusalFallback) this.disabled.add("refusalFallback");

    // Suppress anything the chosen model does not accept. Sending one of these
    // to a model that predates it is a 400, not a graceful ignore.
    if (!this.capabilities.adaptiveThinking) this.disabled.add("adaptiveThinking");
    if (!this.capabilities.effort) this.disabled.add("effort");
    if (!this.capabilities.taskBudget) this.disabled.add("taskBudget");
    if (!this.capabilities.serverFallback) this.disabled.add("refusalFallback");
  }

  get costMeter(): CostMeter {
    return this.meter;
  }

  /**
   * Rebind the event callbacks. For a long-lived agent reused across many
   * requests (a chat session kept alive for prompt-cache warmth), each
   * request needs its own callbacks — swap them in before calling run(), and
   * only when no run is in flight, since they're shared mutable state.
   */
  setEvents(events: AgentEvents): void {
    this.events = events;
  }

  /** Send a task and run until the model stops calling tools. */
  async run(task: string | RunInput): Promise<RunResult> {
    const input: RunInput = typeof task === "string" ? { text: task } : task;
    const isFirstTurn = this.messages.length === 0;
    const text = isFirstTurn ? `${this.environmentPreamble()}\n\n${input.text}` : input.text;

    // Images are vision content, not a tool call — the model sees them
    // directly in the turn rather than fetching them through a tool.
    const content: ContentBlockParam[] = (input.images ?? []).map((image) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
    }));
    content.push({ type: "text", text });

    this.messages.push({ role: "user", content });

    let finalText = "";
    let turns = 0;

    for (let turn = 0; turn < this.config.maxTurns; turn += 1) {
      turns += 1;
      this.applyCacheBreakpoints();

      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await this.request();
      } catch (error) {
        return {
          finalText: finalText || describeError(error),
          turns,
          stoppedBecause: "error",
          meter: this.meter,
        };
      }

      this.meter.add(response.usage);
      this.events.onTurnEnd?.(this.meter);

      // Always append the full content array: thinking blocks and any
      // context-management blocks must survive into the next request unchanged.
      this.messages.push({ role: "assistant", content: response.content });

      const text = collectText(response.content);
      if (text) finalText = text;

      // A refusal is a successful HTTP response with empty or partial content,
      // so it has to be checked before anything reads content as an answer.
      if (response.stop_reason === "refusal") {
        // `stop_details` is populated only on a refusal, and is newer than the
        // installed SDK's types — read it defensively rather than trusting it.
        const details = (response as { stop_details?: { category?: string } | null }).stop_details;
        const category = details?.category ?? "unspecified";
        return {
          finalText: `The model declined this request (category: ${category}). Nothing was changed.`,
          turns,
          stoppedBecause: "refusal",
          meter: this.meter,
        };
      }

      // A server-side tool hit its per-turn iteration cap. Re-send to resume;
      // do not add a user message, the API resumes from the assistant turn.
      if (response.stop_reason === "pause_turn") {
        continue;
      }

      if (response.stop_reason === "max_tokens") {
        return {
          finalText:
            `${finalText}\n\n[Stopped: hit the ${this.config.maxTokens}-token output cap mid-response. `
            + "Re-run with a larger --max-tokens, or split the task.]",
          turns,
          stoppedBecause: "max_tokens",
          meter: this.meter,
        };
      }

      const toolUses = response.content.filter(
        (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
      );

      if (toolUses.length === 0) {
        return { finalText, turns, stoppedBecause: "completed", meter: this.meter };
      }

      // Every tool_use needs a matching tool_result, and they must all come
      // back in a single user message — splitting them across messages teaches
      // the model to stop issuing parallel calls.
      const results = await Promise.all(toolUses.map((use) => this.executeTool(use)));
      this.messages.push({ role: "user", content: results });
    }

    return {
      finalText:
        `${finalText}\n\n[Stopped: reached the ${this.config.maxTurns}-turn limit. `
        + "Re-run with a larger --max-turns to continue.]",
      turns,
      stoppedBecause: "max_turns",
      meter: this.meter,
    };
  }

  // -------------------------------------------------------------------------

  private environmentPreamble(): string {
    return [
      "<environment>",
      `project_root: ${this.config.root}`,
      `platform: ${process.platform}`,
      `approval_mode: ${this.config.approval}`,
      "</environment>",
    ].join("\n");
  }

  private toolDefinitions(): Anthropic.Beta.BetaToolUnion[] {
    const custom = this.persona.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    })) as Anthropic.Beta.BetaToolUnion[];

    if (!this.config.webTools) return custom;
    return [
      ...custom,
      { type: "web_search_20260209", name: "web_search" },
      { type: "web_fetch_20260209", name: "web_fetch" },
    ] as Anthropic.Beta.BetaToolUnion[];
  }

  /**
   * Place cache breakpoints. Render order is tools -> system -> messages, so a
   * breakpoint on the last system block covers tools and system together; two
   * rolling breakpoints on the most recent user messages then extend coverage
   * over the conversation as it grows.
   */
  private applyCacheBreakpoints(): void {
    if (!this.config.promptCaching) return;

    for (const message of this.messages) {
      if (typeof message.content === "string") continue;
      for (const block of message.content as ContentBlockParam[]) {
        if ("cache_control" in block) {
          delete (block as { cache_control?: unknown }).cache_control;
        }
      }
    }

    const userIndices: number[] = [];
    for (let i = 0; i < this.messages.length; i += 1) {
      if (this.messages[i]?.role === "user") userIndices.push(i);
    }

    for (const index of userIndices.slice(-2)) {
      const message = this.messages[index];
      if (!message || typeof message.content === "string") continue;
      const blocks = message.content as ContentBlockParam[];
      const last = blocks[blocks.length - 1];
      if (last) {
        (last as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
      }
    }
  }

  private buildRequest(): Record<string, unknown> {
    const betas: string[] = [];
    const outputConfig: Record<string, unknown> = {};
    const request: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      system: [
        {
          type: "text",
          text: this.persona.systemPrompt,
          ...(this.config.promptCaching ? { cache_control: { type: "ephemeral" } } : {}),
        },
      ],
      messages: this.messages,
      tools: this.toolDefinitions(),
    };

    if (!this.disabled.has("adaptiveThinking")) {
      request["thinking"] = { type: "adaptive", display: "summarized" };
    }
    if (!this.disabled.has("effort")) {
      outputConfig["effort"] = this.config.effort;
    }
    if (!this.disabled.has("contextEditing")) {
      betas.push(BETAS.contextManagement);
      request["context_management"] = { edits: [{ type: "clear_tool_uses_20250919" }] };
    }
    if (!this.disabled.has("taskBudget") && this.config.taskBudget !== null) {
      betas.push(BETAS.taskBudgets);
      outputConfig["task_budget"] = { type: "tokens", total: this.config.taskBudget };
    }
    if (!this.disabled.has("refusalFallback")) {
      betas.push(BETAS.serverSideFallback);
      request["fallbacks"] = "default";
    }

    if (Object.keys(outputConfig).length > 0) request["output_config"] = outputConfig;
    if (betas.length > 0) request["betas"] = betas;
    return request;
  }

  /**
   * Issue one streamed request. On a 400 that names an optional beta feature,
   * drop that feature and retry once — an account without a given beta should
   * degrade to a working agent rather than fail outright. The degradation is
   * announced, never silent.
   */
  private async request(): Promise<Anthropic.Beta.BetaMessage> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.streamOnce();
      } catch (error) {
        const feature = this.degradableFrom(error);
        if (!feature) throw error;
        this.disabled.add(feature);
        this.events.onNotice?.(
          `${FEATURE_LABELS[feature]} is unavailable on this account or model; continuing without it.`,
        );
      }
    }
    return await this.streamOnce();
  }

  private async streamOnce(): Promise<Anthropic.Beta.BetaMessage> {
    const params = this.buildRequest() as unknown as Anthropic.Beta.MessageCreateParamsStreaming;
    const stream = this.client.beta.messages.stream(params);

    for await (const event of stream) {
      if (event.type !== "content_block_delta") continue;
      const delta = event.delta;
      if (delta.type === "text_delta") {
        this.events.onText?.(delta.text);
      } else if (delta.type === "thinking_delta") {
        this.events.onThinking?.(delta.thinking);
      }
    }
    return await stream.finalMessage();
  }

  private degradableFrom(error: unknown): Degradable | null {
    if (!(error instanceof Anthropic.BadRequestError)) return null;
    const message = String(error.message).toLowerCase();
    if (!this.disabled.has("taskBudget") && message.includes("task_budget")) return "taskBudget";
    if (!this.disabled.has("refusalFallback") && message.includes("fallback")) return "refusalFallback";
    if (
      !this.disabled.has("contextEditing")
      && (message.includes("context_management") || message.includes("context-management") || message.includes("clear_tool_uses"))
    ) {
      return "contextEditing";
    }
    if (!this.disabled.has("adaptiveThinking") && message.includes("thinking")) return "adaptiveThinking";
    if (!this.disabled.has("effort") && message.includes("effort")) return "effort";
    return null;
  }

  private async executeTool(
    use: Anthropic.Beta.BetaToolUseBlock,
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    const input = (use.input ?? {}) as Record<string, unknown>;
    this.events.onToolCall?.(use.name, input);

    const tool = this.toolsByName.get(use.name);
    if (!tool) {
      const message = `Unknown tool: ${use.name}`;
      this.events.onToolResult?.(use.name, message, true);
      return { type: "tool_result", tool_use_id: use.id, content: message, is_error: true };
    }

    try {
      const result = await tool.run(input, this.toolContext);
      this.events.onToolResult?.(use.name, result.content, result.isError);
      if (result.card && !result.isError) this.events.onToolCard?.(use.name, result.card);
      return {
        type: "tool_result",
        tool_use_id: use.id,
        content: result.content,
        is_error: result.isError,
      };
    } catch (error) {
      // A failing tool must still return a tool_result — dropping it leaves an
      // unmatched tool_use and the next request is rejected.
      const message =
        error instanceof SafetyError
          ? `Blocked: ${error.message}`
          : `Tool ${use.name} threw: ${(error as Error).message}`;
      this.events.onToolResult?.(use.name, message, true);
      return { type: "tool_result", tool_use_id: use.id, content: message, is_error: true };
    }
  }
}

const FEATURE_LABELS: Record<Degradable, string> = {
  contextEditing: "Context editing",
  taskBudget: "Task budgets",
  refusalFallback: "Server-side refusal fallback",
  adaptiveThinking: "Adaptive thinking",
  effort: "The effort parameter",
};

function collectText(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function describeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Authentication failed. Set ANTHROPIC_API_KEY, or run `ant auth login`.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Rate limited. Wait for the retry-after window, or drop to a cheaper model with --model.";
  }
  if (error instanceof Anthropic.NotFoundError) {
    return `Model not found. Check --model against \`--list-models\`. (${error.message})`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return `Could not reach the API: ${error.message}`;
  }
  if (error instanceof Anthropic.APIError) {
    return `API error ${error.status ?? ""}: ${error.message}`;
  }
  return `Unexpected error: ${(error as Error).message}`;
}
