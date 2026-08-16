/**
 * Model catalogue, pricing, and runtime defaults.
 *
 * Prices are US dollars per million tokens, first-party Claude API rates.
 * Cache writes bill at 1.25x the input rate (5-minute TTL); cache reads at 0.1x.
 */

/**
 * Product name and version of the *harness* — the loop, tools, verifier, and
 * safety layer in this directory. It is not a model, and there is no "Chai-Kan"
 * model behind it: every request is served by whichever Claude model `--model`
 * selects. The banner prints both so the distinction is never ambiguous.
 */
export const HARNESS_VENDOR = "Dhozzi";
export const HARNESS_NAME = "Chai-Kan";
export const HARNESS_VERSION = "7.74";
/** Compact form for tab titles, banners, and anywhere the full name is noise. */
export const HARNESS_SHORT = "CK-7.74";

export interface ModelPricing {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** Human-readable note shown in `--list-models`. */
  note: string;
}

export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export const PRICING: Record<string, ModelPricing> = {
  "claude-opus-5": {
    input: 5,
    output: 25,
    note: "Default. Strongest at agentic coding; best quality-per-dollar for hard work.",
  },
  "claude-fable-5": {
    input: 10,
    output: 50,
    note: "Highest capability, highest price. Thinking is always on.",
  },
  "claude-sonnet-5": {
    input: 2,
    output: 10,
    note: "Near-Opus coding quality at ~40% of the cost. Intro pricing through 2026-08-31.",
  },
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    note: "Cheapest. Mechanical edits only; no thinking or effort support.",
  },
};

export const DEFAULT_MODEL = "claude-opus-5";

/**
 * Map a model id onto its catalogue key.
 *
 * The API accepts both a family alias (`claude-haiku-4-5`) and a dated snapshot
 * (`claude-haiku-4-5-20251001`), and the dated form is the one the docs publish
 * and the one people paste. Keying the catalogue by exact string alone meant the
 * canonical id missed every table in this file, and each miss failed differently
 * and quietly:
 *
 *  - no price, so cost and cost-per-pass read `—` for a model we do price;
 *  - no capability entry, so the unknown-model fallback handed Haiku 4.5 the
 *    modern surface — thinking, effort, task budgets — which it 400s on, the
 *    exact case the fallback comment claims to exclude;
 *  - `in PRICING` validation rejected it, and the web layer silently swapped in
 *    the default model, billing Opus rates for a run the user asked to be Haiku.
 *
 * So resolution is: exact key first, then the same id with a trailing `-YYYYMMDD`
 * removed. Unknown ids still resolve to `undefined` and keep their old behaviour.
 */
const SNAPSHOT_SUFFIX = /-\d{8}$/;

export function resolveModelId(model: string): string | undefined {
  if (model in PRICING) return model;
  const family = model.replace(SNAPSHOT_SUFFIX, "");
  return family !== model && family in PRICING ? family : undefined;
}

/** Catalogue price for a model id, accepting dated snapshots. */
export function pricingFor(model: string): ModelPricing | undefined {
  const key = resolveModelId(model);
  return key === undefined ? undefined : PRICING[key];
}

/** Whether this id names a model in the catalogue, dated snapshots included. */
export function isKnownModel(model: string): boolean {
  return resolveModelId(model) !== undefined;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * `high` is the default rather than `xhigh` because it is the better
 * cost/quality balance for most tasks. Raise to `xhigh` for large refactors.
 */
export const DEFAULT_EFFORT: Effort = "high";

/**
 * Per-model request-surface support.
 *
 * These are not preferences — sending an unsupported parameter is a 400. Adaptive
 * thinking and `effort` arrived with the 4.6+ generation, so Haiku 4.5 accepts
 * neither; server-side refusal fallback is only wired up for the two models whose
 * safety classifiers can decline a request.
 */
export interface ModelCapabilities {
  adaptiveThinking: boolean;
  effort: boolean;
  taskBudget: boolean;
  serverFallback: boolean;
}

const MODERN: ModelCapabilities = {
  adaptiveThinking: true,
  effort: true,
  taskBudget: true,
  serverFallback: false,
};

export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  "claude-opus-5": { ...MODERN, serverFallback: true },
  "claude-fable-5": { ...MODERN, serverFallback: true },
  "claude-sonnet-5": { ...MODERN },
  "claude-haiku-4-5": {
    adaptiveThinking: false,
    effort: false,
    taskBudget: false,
    serverFallback: false,
  },
};

/**
 * Unknown model ids get the modern surface, because every current model except
 * Haiku 4.5 supports it. Anything that still 400s is caught by the runtime
 * degradation path in the agent loop.
 *
 * A dated snapshot resolves to its family first, so `claude-haiku-4-5-20251001`
 * gets Haiku's restricted surface rather than falling through to `MODERN` and
 * spending three round-trips discovering it by 400.
 */
export function capabilitiesFor(model: string): ModelCapabilities {
  const key = resolveModelId(model) ?? model;
  return MODEL_CAPABILITIES[key] ?? MODERN;
}

/** Beta features this agent can use. Each is independently degradable. */
export const BETAS = {
  contextManagement: "context-management-2025-06-27",
  taskBudgets: "task-budgets-2026-03-13",
  serverSideFallback: "server-side-fallback-2026-07-01",
} as const;

export interface AgentConfig {
  model: string;
  effort: Effort;
  /** Absolute path. All file and shell operations are confined to this tree. */
  root: string;
  maxTurns: number;
  /** Per-response output cap. Streaming is always used, so this can be large. */
  maxTokens: number;
  /**
   * Token ceiling the model is made aware of so it paces itself across the
   * whole run. Minimum accepted by the API is 20000. `null` disables it.
   */
  taskBudget: number | null;
  promptCaching: boolean;
  contextEditing: boolean;
  refusalFallback: boolean;
  webTools: boolean;
  /** How to handle tools that mutate state. */
  approval: ApprovalMode;
  /** Emit machine-readable JSON events instead of prose. */
  json: boolean;
  /**
   * Hold the agent's work to the project's own checks and send failures back
   * for repair. Ignored in readonly mode, where nothing changes.
   */
  verify: boolean;
  /** Repair rounds attempted after the first verification failure. */
  repairAttempts: number;
  /**
   * Treat an already-failing check as part of the task rather than as somebody
   * else's bug. Off by default so the agent does not chase failures it did not
   * cause; on when the task is explicitly to get a red suite green.
   */
  requireGreen: boolean;
}

export type ApprovalMode = "ask" | "auto" | "readonly";

export const DEFAULT_CONFIG: Omit<AgentConfig, "root"> = {
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
  maxTurns: 60,
  maxTokens: 64000,
  taskBudget: null,
  promptCaching: true,
  contextEditing: true,
  refusalFallback: true,
  webTools: false,
  approval: "ask",
  json: false,
  verify: true,
  repairAttempts: 3,
  requireGreen: false,
};

/** Hard caps that keep a single tool result from blowing up the context window. */
export const LIMITS = {
  /** Max characters returned by a single `read` call. */
  readChars: 120_000,
  /** Max characters of combined stdout+stderr returned by `bash`. */
  bashChars: 30_000,
  /** Max wall-clock milliseconds for a single `bash` call. */
  bashTimeoutMs: 120_000,
  /** Max matches returned by `grep`. */
  grepMatches: 200,
  /** Max paths returned by `glob`. */
  globPaths: 500,
  /** Files larger than this are refused by `read` (bytes). */
  maxFileBytes: 5_000_000,
} as const;
