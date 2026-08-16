/**
 * Eleanor's session store.
 *
 * Base44 owns accounts, storage, and conversation history — this store's only
 * job is keeping one long-lived Agent per user alive between HTTP requests,
 * for the same reason src/web/sessions.ts does it for the coding harness: a
 * fresh agent per request would re-send the whole conversation uncached, and
 * for a chatty daily assistant that cost compounds fast (see the pricing
 * research this was built against — Eleanor's unit economics depend on the
 * cache staying warm).
 *
 * One run at a time per session, same constraint as the coding web layer:
 * the agent mutates its own message array, so two overlapping runs would
 * interleave turns into it and corrupt the conversation.
 */

import { Agent, type AgentEvents, type AgentPersona } from "../agent.js";
import { DEFAULT_CONFIG, type AgentConfig } from "../config.js";
import { ELEANOR_SYSTEM_PROMPT } from "./persona.js";
import { ELEANOR_TOOLS } from "./tools.js";

export const ELEANOR_PERSONA: AgentPersona = {
  systemPrompt: ELEANOR_SYSTEM_PROMPT,
  tools: ELEANOR_TOOLS,
};

/** Sessions idle this long are dropped; the next message just starts a fresh one. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export class SessionBusyError extends Error {
  constructor() {
    super("This session is already answering a message. Wait for it to finish before sending another.");
    this.name = "SessionBusyError";
  }
}

interface Entry {
  agent: Agent;
  lastUsedAt: number;
  running: boolean;
}

export class EleanorSessionStore {
  private readonly sessions = new Map<string, Entry>();
  private readonly config: AgentConfig;
  private readonly idleTimeoutMs: number;

  constructor(overrides: Partial<AgentConfig> = {}, idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS) {
    this.idleTimeoutMs = idleTimeoutMs;
    this.config = {
      ...DEFAULT_CONFIG,
      // `root` and filesystem `approval` are unused — Eleanor's tool surface
      // has nothing that touches a project tree — but AgentConfig requires
      // them, so these are inert placeholders, not live settings.
      root: process.cwd(),
      approval: "auto",
      verify: false,
      webTools: true,
      model: "claude-haiku-4-5",
      ...overrides,
    };
  }

  /**
   * Run one message against the session for `userId`, creating the session
   * on first contact. Rejects if a run is already in flight for this user —
   * the caller should surface that as a 409, not queue silently.
   */
  async send(userId: string, events: AgentEvents, run: (agent: Agent) => Promise<void>): Promise<void> {
    this.evictIdle();
    let entry = this.sessions.get(userId);
    if (!entry) {
      entry = { agent: new Agent(this.config, events, ELEANOR_PERSONA), lastUsedAt: Date.now(), running: false };
      this.sessions.set(userId, entry);
    }
    if (entry.running) throw new SessionBusyError();

    entry.agent.setEvents(events);
    entry.running = true;
    entry.lastUsedAt = Date.now();
    try {
      await run(entry.agent);
    } finally {
      entry.running = false;
      entry.lastUsedAt = Date.now();
    }
  }

  /** Number of live sessions — exposed for a health/metrics endpoint. */
  get size(): number {
    return this.sessions.size;
  }

  private evictIdle(): void {
    const cutoff = Date.now() - this.idleTimeoutMs;
    for (const [userId, entry] of this.sessions) {
      if (!entry.running && entry.lastUsedAt < cutoff) this.sessions.delete(userId);
    }
  }
}
