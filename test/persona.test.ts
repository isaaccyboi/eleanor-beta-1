/**
 * Regression tests for Eleanor's voice rules, checked against the actual
 * system prompt text rather than trusted from a one-time edit. Two of these
 * are explicit product requirements: no emoji and no em dashes, ever.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ELEANOR_SYSTEM_PROMPT } from "../src/eleanor/persona.js";

describe("Eleanor's system prompt", () => {
  it("never uses an em dash", () => {
    assert.doesNotMatch(ELEANOR_SYSTEM_PROMPT, /—/);
  });

  it("never uses emoji", () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    assert.doesNotMatch(ELEANOR_SYSTEM_PROMPT, emoji);
  });

  it("explicitly instructs against both, not just happens to avoid them", () => {
    assert.match(ELEANOR_SYSTEM_PROMPT, /no emoji/i);
    assert.match(ELEANOR_SYSTEM_PROMPT, /em dash/i);
  });

  it("never uses an exclamation mark", () => {
    assert.doesNotMatch(ELEANOR_SYSTEM_PROMPT, /!/);
  });
});
