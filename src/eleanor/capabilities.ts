/**
 * What Eleanor can do, and how she admits to it.
 *
 * Eleanor is built for people who did not grow up with this and have been told,
 * repeatedly, that it is coming for their job. A feature list on a landing page
 * reads as a threat to that person. So there isn't one. Eleanor simply does the
 * work, and the first time she uses something the user has not seen before, she
 * mentions it afterwards in a sentence.
 *
 * The copy below is that sentence. It is written the way Eleanor talks: past tense,
 * plain words, no exclamation marks, no "unlocked", no congratulating the user
 * for having witnessed software. `did` says what happened; `next` says what it
 * means for them going forward. Both are optional to read and neither blocks
 * the actual answer.
 */

export interface Capability {
  /** Stable id. Persisted per user, so renaming one re-discloses it. */
  id: string;
  /** Tool names that count as an exercise of this capability. */
  tools: readonly string[];
  /** What just happened, in Eleanor's voice. */
  did: string;
  /** What it means for them next time. */
  next: string;
  /**
   * How surprising this is to someone who thinks "AI" means a chat box.
   * Only the highest-weighted new capability is disclosed per turn; the rest
   * wait. Nobody wants four of these at once.
   */
  weight: number;
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "web.search",
    tools: ["web_search"],
    did: "I looked that up just now rather than going from memory, so it's current.",
    next: "Anything that changes, prices, opening times, who won, ask and I'll check.",
    weight: 60,
  },
  {
    id: "web.read",
    tools: ["web_fetch"],
    did: "I read the page itself rather than guessing from the headline.",
    next: "Send me a link any time and I'll tell you what it actually says.",
    weight: 55,
  },
  {
    id: "image.read",
    tools: ["image_read"],
    did: "I had a proper look at the picture you sent.",
    next: "Photos are fine: a dress, a document, a rash, a form you've been sent.",
    weight: 90,
  },
  {
    id: "compare",
    tools: ["compare_options"],
    did: "I weighed those against each other rather than just listing them.",
    next: "When you're stuck between things, give me both and I'll tell you which and why.",
    weight: 70,
  },
  {
    id: "draft",
    tools: ["draft_text"],
    did: "I wrote that in your words, not mine. I matched how you'd already put it.",
    next: "Emails, letters, the awkward ones especially. I'll draft and you edit.",
    weight: 65,
  },
  {
    id: "explain",
    tools: ["explain_term"],
    did: "I've kept the jargon out of that.",
    next: "If anyone sends you something full of terms, paste it here and I'll translate.",
    weight: 40,
  },
];

const BY_TOOL = new Map<string, Capability>();
for (const capability of CAPABILITIES) {
  for (const tool of capability.tools) BY_TOOL.set(tool, capability);
}

/** The capability a tool call exercises, if the tool maps to one. */
export function capabilityForTool(tool: string): Capability | undefined {
  return BY_TOOL.get(tool);
}
