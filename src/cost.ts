/**
 * Token accounting.
 *
 * The point of tracking this per turn is that cache behaviour is invisible
 * otherwise: a cache that silently stops being read looks identical to one
 * that works, except on the invoice. `cacheHitRate` surfaces it immediately.
 */

import { CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER, pricingFor } from "./config.js";

export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export class CostMeter {
  private readonly model: string;

  uncachedInput = 0;
  cacheWrite = 0;
  cacheRead = 0;
  output = 0;
  turns = 0;

  constructor(model: string) {
    this.model = model;
  }

  add(usage: UsageLike | null | undefined): void {
    if (!usage) return;
    this.turns += 1;
    this.uncachedInput += usage.input_tokens ?? 0;
    this.output += usage.output_tokens ?? 0;
    this.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    this.cacheRead += usage.cache_read_input_tokens ?? 0;
  }

  /** Total prompt tokens seen, cached or not. */
  get totalInput(): number {
    return this.uncachedInput + this.cacheWrite + this.cacheRead;
  }

  /**
   * Share of prompt tokens served from cache. A healthy multi-turn run climbs
   * toward 0.9+; a run stuck near 0 means something is invalidating the prefix
   * on every request.
   */
  get cacheHitRate(): number {
    return this.totalInput === 0 ? 0 : this.cacheRead / this.totalInput;
  }

  /** Estimated spend in USD. Returns null for a model with no known price. */
  get costUsd(): number | null {
    const price = pricingFor(this.model);
    if (!price) return null;
    const billableInput =
      this.uncachedInput
      + this.cacheWrite * CACHE_WRITE_MULTIPLIER
      + this.cacheRead * CACHE_READ_MULTIPLIER;
    return (billableInput * price.input + this.output * price.output) / 1_000_000;
  }

  /**
   * What the same run would have cost with caching switched off, so the saving
   * is stated rather than implied.
   */
  get costWithoutCachingUsd(): number | null {
    const price = pricingFor(this.model);
    if (!price) return null;
    return (this.totalInput * price.input + this.output * price.output) / 1_000_000;
  }

  summary(): string {
    const cost = this.costUsd;
    const naive = this.costWithoutCachingUsd;
    const parts = [
      `${this.turns} turns`,
      `in ${fmt(this.totalInput)} (${(this.cacheHitRate * 100).toFixed(0)}% cached)`,
      `out ${fmt(this.output)}`,
    ];
    if (cost !== null) {
      parts.push(`$${cost.toFixed(4)}`);
      if (naive !== null && naive > cost) {
        const saved = ((1 - cost / naive) * 100).toFixed(0);
        parts.push(`(${saved}% under uncached)`);
      }
    }
    return parts.join("  ·  ");
  }

  toJSON() {
    return {
      model: this.model,
      turns: this.turns,
      uncached_input_tokens: this.uncachedInput,
      cache_write_tokens: this.cacheWrite,
      cache_read_tokens: this.cacheRead,
      output_tokens: this.output,
      cache_hit_rate: Number(this.cacheHitRate.toFixed(4)),
      cost_usd: this.costUsd,
      cost_usd_without_caching: this.costWithoutCachingUsd,
    };
  }
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
