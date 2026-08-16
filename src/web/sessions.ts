/**
 * Session state for the web front end.
 *
 * A session owns one long-lived `Agent`, which is the whole point: the agent
 * keeps its message history, so the prompt cache stays warm across every
 * message you send it. A fresh agent per request would re-send the entire
 * conversation uncached and cost roughly ten times as much.
 *
 * Two constraints shape the rest of this module:
 *
 *  1. **No approval prompts.** `confirm()` needs a TTY, and a browser is not
 *     one — in `ask` mode every write would be silently denied. So the web
 *     surface offers exactly two honest modes instead: `read` (inspection
 *     only) and `build` (writes pre-approved). It never uses `ask`.
 *
 *  2. **One task at a time per session.** The agent mutates its own message
 *     array; two overlapping runs would interleave turns into it and corrupt
 *     the conversation.
 */

import { randomUUID } from "node:crypto";
import { Agent, type AgentEvents } from "../agent.js";
import { CostMeter } from "../cost.js";
import { DEFAULT_CONFIG, type AgentConfig, type Effort } from "../config.js";
import { formatVerdict, runSupervised, type TaskRunner } from "../supervisor.js";
import { detectChecks } from "../verify.js";

/** What a session needs from an agent: run a task, and account for the spend. */
export interface AgentLike extends TaskRunner {
  readonly costMeter: CostMeter;
}

/** Injectable so the web layer can be tested without a model or an API key. */
export type SessionAgentFactory = (config: AgentConfig, events: AgentEvents) => AgentLike;

export const defaultSessionAgentFactory: SessionAgentFactory = (config, events) =>
  new Agent(config, events);

/** How the agent is allowed to treat the project. */
export type SessionMode = "read" | "build";

export interface SessionSettings {
  model: string;
  effort: Effort;
  mode: SessionMode;
  verify: boolean;
}

/** Everything the browser is told about a run, in order. */
export type WebEvent =
  | { type: "phase"; text: string }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "tool_result"; name: string; ok: boolean; preview: string }
  | { type: "notice"; text: string }
  | { type: "usage"; turns: number; input: number; output: number; cacheHitRate: number; costUsd: number | null }
  | { type: "done"; verdict: string | null; summary: string; stoppedBecause: string }
  | { type: "error"; message: string };

export type EventSink = (event: WebEvent) => void;

/** Sessions with no activity for this long are dropped along with their history. */
const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const TOOL_RESULT_PREVIEW_CHARS = 240;

export class Session {
  readonly id = randomUUID();
  readonly root: string;
  readonly createdAt = Date.now();

  private settings: SessionSettings;
  private readonly makeAgent: SessionAgentFactory;
  private agent: AgentLike | null = null;
  private sink: EventSink | null = null;
  private lastUsedAt = Date.now();
  private running = false;

  constructor(
    root: string,
    settings: SessionSettings,
    makeAgent: SessionAgentFactory = defaultSessionAgentFactory,
  ) {
    this.root = root;
    this.settings = settings;
    this.makeAgent = makeAgent;
  }

  get idleMs(): number {
    return Date.now() - this.lastUsedAt;
  }

  get busy(): boolean {
    return this.running;
  }

  get currentSettings(): SessionSettings {
    return { ...this.settings };
  }

  /**
   * Apply settings for an incoming message.
   *
   * Anything that changes the agent's request surface — the model, or the
   * approval mode baked into its config — invalidates the live agent, because
   * those are fixed at construction. History is dropped with it, which is
   * honest: a conversation half-answered by one model and half by another is
   * not a conversation either model actually had.
   */
  applySettings(next: SessionSettings): { historyReset: boolean } {
    const structural =
      next.model !== this.settings.model || next.mode !== this.settings.mode;
    this.settings = next;
    if (structural && this.agent !== null) {
      this.agent = null;
      return { historyReset: true };
    }
    return { historyReset: false };
  }

  /** The checks this session would be graded against, for display. */
  detectedChecks(): string[] {
    return detectChecks(this.root).map((check) => check.name);
  }

  private configFor(settings: SessionSettings): AgentConfig {
    return {
      ...DEFAULT_CONFIG,
      root: this.root,
      model: settings.model,
      effort: settings.effort,
      // Never `ask`: there is no terminal behind a browser to answer it, so
      // every mutating call would be denied without explanation.
      approval: settings.mode === "read" ? "readonly" : "auto",
      // Nothing changed in read mode, so there is nothing to grade.
      verify: settings.mode === "build" && settings.verify,
    };
  }

  /**
   * Run one task, streaming events to `sink`.
   *
   * Errors are reported as events rather than thrown: the caller is an HTTP
   * response that has already been flushed, so there is nowhere for a rejection
   * to usefully go.
   */
  async send(task: string, sink: EventSink): Promise<void> {
    if (this.running) {
      sink({ type: "error", message: "This session is already running a task. Wait for it to finish." });
      return;
    }

    this.running = true;
    this.lastUsedAt = Date.now();
    this.sink = sink;

    try {
      const config = this.configFor(this.settings);
      const agent = this.agent ?? this.makeAgent(config, this.agentEvents());
      this.agent = agent;

      if (config.verify) {
        const result = await runSupervised(agent, config, task, {
          maxRepairAttempts: config.repairAttempts,
          onPhase: (text) => this.emit({ type: "phase", text }),
        });
        this.emitUsage(agent.costMeter);
        this.emit({
          type: "done",
          verdict: result.verdict,
          summary: formatVerdict(result),
          stoppedBecause: result.run.stoppedBecause,
        });
      } else {
        const run = await agent.run(task);
        this.emitUsage(agent.costMeter);
        this.emit({
          type: "done",
          verdict: null,
          summary: config.approval === "readonly"
            ? "Read-only run — nothing was changed, so there was nothing to verify."
            : "Ran without verification.",
          stoppedBecause: run.stoppedBecause,
        });
      }
    } catch (error) {
      this.emit({ type: "error", message: (error as Error).message });
    } finally {
      this.running = false;
      this.lastUsedAt = Date.now();
      this.sink = null;
    }
  }

  private emit(event: WebEvent): void {
    this.sink?.(event);
  }

  private emitUsage(meter: CostMeter): void {
    this.emit({
      type: "usage",
      turns: meter.turns,
      input: meter.totalInput,
      output: meter.output,
      cacheHitRate: meter.cacheHitRate,
      costUsd: meter.costUsd,
    });
  }

  private agentEvents() {
    return {
      onText: (text: string) => this.emit({ type: "text", text }),
      onThinking: (text: string) => this.emit({ type: "thinking", text }),
      onNotice: (text: string) => this.emit({ type: "notice", text }),
      onToolCall: (name: string, input: Record<string, unknown>) =>
        this.emit({ type: "tool", name, detail: describeToolCall(name, input) }),
      onToolResult: (name: string, result: string, isError: boolean) =>
        this.emit({
          type: "tool_result",
          name,
          ok: !isError,
          preview: preview(result),
        }),
      onTurnEnd: (meter: CostMeter) => this.emitUsage(meter),
    };
  }
}

/**
 * A one-line description of what a tool call is about to do.
 *
 * Raw JSON input is unreadable in a chat transcript — a 400-line `write` would
 * bury everything around it — so each tool contributes only the field that
 * identifies the target.
 */
export function describeToolCall(name: string, input: Record<string, unknown>): string {
  const str = (key: string): string => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (name) {
    case "read":
    case "write":
    case "edit":
      return str("path");
    case "glob":
      return str("pattern");
    case "grep": {
      const path = str("path");
      return path ? `${str("pattern")} in ${path}` : str("pattern");
    }
    case "bash":
      return str("command");
    default: {
      const compact = JSON.stringify(input);
      return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact;
    }
  }
}

function preview(text: string): string {
  const clean = text.trim();
  if (clean.length <= TOOL_RESULT_PREVIEW_CHARS) return clean;
  return `${clean.slice(0, TOOL_RESULT_PREVIEW_CHARS)}…`;
}

/** In-memory session registry. Sessions die with the process, by design. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly makeAgent: SessionAgentFactory;

  constructor(makeAgent: SessionAgentFactory = defaultSessionAgentFactory) {
    this.makeAgent = makeAgent;
  }

  create(root: string, settings: SessionSettings): Session {
    this.evictIdle();
    const session = new Session(root, settings, this.makeAgent);
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Drop idle sessions so a long-running server does not retain transcripts forever. */
  evictIdle(idleTimeoutMs = IDLE_TIMEOUT_MS): number {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.busy) continue;
      if (session.idleMs > idleTimeoutMs) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
