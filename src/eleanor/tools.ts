/**
 * Eleanor's tool surface.
 *
 * Deliberately small. Web search and web page reading are Anthropic's own
 * server-side tools (turned on via `webTools` in AgentConfig, same as the
 * coding harness) — Eleanor does her research with those. This file holds
 * only what those tools can't do on their own: turning research she's already
 * done into something a UI can render as more than a paragraph.
 *
 * `image_read` and `explain_term` are not tools at all. Reading an image is
 * native vision — the picture goes straight into the message content in
 * agent.ts, there is nothing to dispatch. Explaining a term is just Eleanor
 * talking. Neither has a dispatchable call, so neither belongs here; a caller
 * that wants to record either capability for discovery does so directly
 * rather than through a fake tool built only to fire an event.
 */

import { SafetyError } from "../safety.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../tools.js";

const ok = (content: string, card?: Record<string, unknown>): ToolResult => ({
  content,
  isError: false,
  card,
});
const fail = (content: string): ToolResult => ({ content, isError: true });

interface RawOption {
  label?: unknown;
  imageUrl?: unknown;
  price?: unknown;
  reason?: unknown;
}

interface ComparisonOption {
  label: string;
  imageUrl?: string;
  price?: string;
  reason: string;
}

function parseOption(raw: RawOption, index: number): ComparisonOption {
  if (typeof raw.label !== "string" || !raw.label.trim()) {
    throw new SafetyError(`options[${index}].label is required and must be a non-empty string`);
  }
  if (typeof raw.reason !== "string" || !raw.reason.trim()) {
    throw new SafetyError(
      `options[${index}].reason is required. A card with no reason is a list, not a judgment.`,
    );
  }
  return {
    label: raw.label,
    reason: raw.reason,
    ...(typeof raw.imageUrl === "string" && raw.imageUrl ? { imageUrl: raw.imageUrl } : {}),
    ...(typeof raw.price === "string" && raw.price ? { price: raw.price } : {}),
  };
}

const compareOptionsTool: ToolDefinition = {
  name: "compare_options",
  description:
    "Present a short, judged comparison of real options you have already researched (with web_search / "
    + "web_fetch) as cards the interface can render, rather than a paragraph. Use this only after you have "
    + "actually found the specific things being compared. Never invent options to fill the slots. Give 2 "
    + "options, 3 at the absolute most; each needs a genuine reason it suits her specifically, not a generic "
    + "description. If nothing you found is worth presenting, say so in plain text instead of calling this.",
  input_schema: {
    type: "object",
    properties: {
      options: {
        type: "array",
        minItems: 2,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "What it is, plainly, not a marketing name." },
            imageUrl: { type: "string", description: "A real image URL found during research, if there is one." },
            price: { type: "string", description: "As found, e.g. \"$89\"; omit if unknown, never guess." },
            reason: { type: "string", description: "Why this one suits her, specifically. Required." },
          },
          required: ["label", "reason"],
        },
      },
    },
    required: ["options"],
  },
  readOnly: true,
  async run(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const rawOptions = input["options"];
    if (!Array.isArray(rawOptions) || rawOptions.length < 2) {
      return fail("`options` must be an array of at least 2 items.");
    }
    if (rawOptions.length > 3) {
      return fail("At most 3 options. A comparison this long stops being a judgment.");
    }

    let options: ComparisonOption[];
    try {
      options = rawOptions.map((raw, i) => parseOption(raw as RawOption, i));
    } catch (error) {
      return fail(error instanceof SafetyError ? error.message : String(error));
    }

    const summary = options.map((o, i) => `${i + 1}. ${o.label}: ${o.reason}`).join("\n");
    return ok(
      `Presented ${options.length} options for comparison:\n${summary}`,
      { type: "compare_options", options },
    );
  },
};

export const ELEANOR_TOOLS: readonly ToolDefinition[] = [compareOptionsTool];
