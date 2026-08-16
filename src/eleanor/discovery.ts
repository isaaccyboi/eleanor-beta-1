/**
 * The discovery ledger.
 *
 * Eleanor reveals what she can do by doing it and then saying so once. This tracks
 * what a given person has already been shown, so the second time she searches
 * the web she says nothing about searching the web.
 *
 * Four rules hold this together, and they are all about not being annoying:
 *
 *   1. Disclosure follows value. A card is only ever produced at the end of a
 *      turn, alongside the answer. Eleanor never opens with what she is capable of.
 *   2. Failure discloses nothing. If the tool errored the person got nothing
 *      out of it, and announcing the capability anyway would be advertising.
 *   3. One card per turn. Eleanor may have used four new things; she mentions the
 *      most surprising one and the others keep until they come up again.
 *   4. Seen once is seen forever. The ledger persists across sessions.
 */

import { capabilityForTool, type Capability } from "./capabilities.js";

export interface DiscoveryCard {
  capabilityId: string;
  did: string;
  next: string;
}

/** Serialised form, safe to store per user. */
export interface DiscoveryState {
  seen: string[];
}

export class DiscoveryLedger {
  private readonly seen: Set<string>;
  /** Capabilities exercised successfully in the current turn. */
  private pending = new Map<string, Capability>();

  constructor(state: DiscoveryState = { seen: [] }) {
    this.seen = new Set(state.seen);
  }

  /**
   * Record a tool call that has already returned. `isError` is required rather
   * than defaulted because rule 2 is the whole point: a caller that forgets to
   * pass it would silently start advertising failed work.
   */
  record(tool: string, isError: boolean): void {
    if (isError) return;
    const capability = capabilityForTool(tool);
    if (!capability) return;
    if (this.seen.has(capability.id)) return;
    this.pending.set(capability.id, capability);
  }

  /**
   * Close the turn and return the single card to show, if any. Marks that
   * capability as seen; anything else that fired this turn is dropped and will
   * be disclosed the next time it is genuinely used.
   */
  settle(): DiscoveryCard | undefined {
    const candidates = [...this.pending.values()];
    this.pending = new Map();
    if (candidates.length === 0) return undefined;

    // Ties break on id so the same turn always yields the same card.
    const chosen = candidates.reduce((best, next) =>
      next.weight > best.weight || (next.weight === best.weight && next.id < best.id) ? next : best,
    );
    this.seen.add(chosen.id);
    return { capabilityId: chosen.id, did: chosen.did, next: chosen.next };
  }

  /** True once this person has been shown the capability. */
  hasSeen(capabilityId: string): boolean {
    return this.seen.has(capabilityId);
  }

  toState(): DiscoveryState {
    return { seen: [...this.seen] };
  }
}
