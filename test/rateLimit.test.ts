/**
 * Tests for the sliding-window rate limiter guarding Eleanor's API.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RateLimiter } from "../src/eleanor/rateLimit.js";

describe("RateLimiter", () => {
  it("allows calls up to the limit", () => {
    const limiter = new RateLimiter(3, 60_000);
    assert.equal(limiter.allow("u1", 0), true);
    assert.equal(limiter.allow("u1", 1), true);
    assert.equal(limiter.allow("u1", 2), true);
  });

  it("rejects the call once the limit is reached", () => {
    const limiter = new RateLimiter(2, 60_000);
    assert.equal(limiter.allow("u1", 0), true);
    assert.equal(limiter.allow("u1", 1), true);
    assert.equal(limiter.allow("u1", 2), false);
  });

  it("does not consume a slot for a rejected call", () => {
    const limiter = new RateLimiter(1, 60_000);
    assert.equal(limiter.allow("u1", 0), true);
    assert.equal(limiter.allow("u1", 1), false);
    assert.equal(limiter.allow("u1", 2), false);
    // Never actually got a second allowed hit, so once the window clears,
    // a fresh call should be allowed again rather than staying jammed.
    assert.equal(limiter.allow("u1", 60_001), true);
  });

  it("allows again once old hits fall outside the window", () => {
    const limiter = new RateLimiter(1, 1000);
    assert.equal(limiter.allow("u1", 0), true);
    assert.equal(limiter.allow("u1", 500), false);
    assert.equal(limiter.allow("u1", 1001), true);
  });

  it("tracks each key independently", () => {
    const limiter = new RateLimiter(1, 60_000);
    assert.equal(limiter.allow("u1", 0), true);
    assert.equal(limiter.allow("u2", 0), true);
    assert.equal(limiter.allow("u1", 1), false);
    assert.equal(limiter.allow("u2", 1), false);
  });
});
