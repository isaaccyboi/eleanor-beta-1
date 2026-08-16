/**
 * Tests for the discovery ledger.
 *
 * The properties worth defending are the ones that keep Eleanor from behaving like
 * every other product this person has been sold: she must not announce a
 * capability before it has produced anything, must not announce one that
 * failed, must not announce four at once, and must not announce the same one
 * twice — including next week, in a new session.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DiscoveryLedger } from "../src/eleanor/discovery.js";
import { CAPABILITIES, capabilityForTool } from "../src/eleanor/capabilities.js";

describe("capability catalogue", () => {
  it("maps every declared tool back to its capability", () => {
    for (const capability of CAPABILITIES) {
      for (const tool of capability.tools) {
        assert.equal(capabilityForTool(tool)?.id, capability.id);
      }
    }
  });

  it("keeps ids unique", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("does not claim a tool for two capabilities", () => {
    const tools = CAPABILITIES.flatMap((c) => [...c.tools]);
    assert.equal(new Set(tools).size, tools.length);
  });

  it("writes card copy in Eleanor's voice", () => {
    // The banned words are the ones that make her sound like a brochure. A
    // failure here means someone edited the copy without reading the persona.
    const banned = /\b(unlock|empower|seamless|journey|leverage|supercharge|exciting)\b/i;
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    for (const capability of CAPABILITIES) {
      assert.doesNotMatch(capability.did, banned, `${capability.id}.did`);
      assert.doesNotMatch(capability.next, banned, `${capability.id}.next`);
      assert.doesNotMatch(capability.did, /!/, `${capability.id}.did has an exclamation mark`);
      assert.doesNotMatch(capability.next, /!/, `${capability.id}.next has an exclamation mark`);
      assert.doesNotMatch(capability.did, /—/, `${capability.id}.did has an em dash`);
      assert.doesNotMatch(capability.next, /—/, `${capability.id}.next has an em dash`);
      assert.doesNotMatch(capability.did, emoji, `${capability.id}.did has an emoji`);
      assert.doesNotMatch(capability.next, emoji, `${capability.id}.next has an emoji`);
    }
  });
});

describe("first disclosure", () => {
  it("produces a card the first time a capability is used", () => {
    const ledger = new DiscoveryLedger();
    ledger.record("web_search", false);

    const card = ledger.settle();
    assert.equal(card?.capabilityId, "web.search");
    assert.ok(card.did.length > 0);
    assert.ok(card.next.length > 0);
  });

  it("says nothing the second time", () => {
    const ledger = new DiscoveryLedger();
    ledger.record("web_search", false);
    ledger.settle();

    ledger.record("web_search", false);
    assert.equal(ledger.settle(), undefined);
  });

  it("says nothing when no tool ran", () => {
    const ledger = new DiscoveryLedger();
    assert.equal(ledger.settle(), undefined);
  });

  it("ignores tools that are not capabilities", () => {
    const ledger = new DiscoveryLedger();
    ledger.record("some_internal_tool", false);
    assert.equal(ledger.settle(), undefined);
  });
});

describe("failure discloses nothing", () => {
  it("withholds the card when the tool errored", () => {
    const ledger = new DiscoveryLedger();
    ledger.record("image_read", true);

    assert.equal(ledger.settle(), undefined);
    assert.equal(ledger.hasSeen("image.read"), false);
  });

  it("still discloses on a later successful use", () => {
    const ledger = new DiscoveryLedger();
    ledger.record("image_read", true);
    ledger.settle();

    ledger.record("image_read", false);
    assert.equal(ledger.settle()?.capabilityId, "image.read");
  });

  it("discloses when one call fails and another succeeds in the same turn", () => {
    const ledger = new DiscoveryLedger();
    ledger.record("web_search", true);
    ledger.record("web_search", false);

    assert.equal(ledger.settle()?.capabilityId, "web.search");
  });
});

describe("one card per turn", () => {
  it("shows only the most surprising capability", () => {
    const ledger = new DiscoveryLedger();
    ledger.record("explain_term", false); // weight 40
    ledger.record("image_read", false); // weight 90
    ledger.record("web_search", false); // weight 60

    assert.equal(ledger.settle()?.capabilityId, "image.read");
  });

  it("does not silently burn the capabilities it held back", () => {
    const ledger = new DiscoveryLedger();
    ledger.record("explain_term", false);
    ledger.record("image_read", false);
    ledger.settle();

    assert.equal(ledger.hasSeen("image.read"), true);
    assert.equal(ledger.hasSeen("explain.term"), false);
    assert.equal(ledger.hasSeen("explain"), false);
  });

  it("discloses a held-back capability the next time it is used", () => {
    const ledger = new DiscoveryLedger();
    ledger.record("explain_term", false);
    ledger.record("image_read", false);
    ledger.settle();

    ledger.record("explain_term", false);
    assert.equal(ledger.settle()?.capabilityId, "explain");
  });

  it("counts repeated calls in one turn as a single capability", () => {
    const ledger = new DiscoveryLedger();
    ledger.record("web_search", false);
    ledger.record("web_search", false);
    ledger.record("web_search", false);

    assert.equal(ledger.settle()?.capabilityId, "web.search");
    assert.equal(ledger.settle(), undefined);
  });

  it("clears pending state even when everything was already seen", () => {
    const ledger = new DiscoveryLedger({ seen: ["web.search"] });
    ledger.record("web_search", false);

    assert.equal(ledger.settle(), undefined);
    assert.deepEqual(ledger.toState().seen, ["web.search"]);
  });
});

describe("persistence", () => {
  it("does not re-disclose across sessions", () => {
    const first = new DiscoveryLedger();
    first.record("web_search", false);
    first.settle();

    const later = new DiscoveryLedger(first.toState());
    later.record("web_search", false);
    assert.equal(later.settle(), undefined);
  });

  it("round-trips through its serialised form", () => {
    const ledger = new DiscoveryLedger();
    ledger.record("image_read", false);
    ledger.settle();

    const state = ledger.toState();
    assert.deepEqual(state, { seen: ["image.read"] });
    assert.equal(new DiscoveryLedger(state).hasSeen("image.read"), true);
  });

  it("starts a brand new person with nothing seen", () => {
    const ledger = new DiscoveryLedger();
    assert.deepEqual(ledger.toState().seen, []);
    for (const capability of CAPABILITIES) {
      assert.equal(ledger.hasSeen(capability.id), false);
    }
  });
});

describe("determinism", () => {
  it("picks the same card for the same turn every time", () => {
    const chosen = new Set<string>();
    for (let run = 0; run < 10; run += 1) {
      const ledger = new DiscoveryLedger();
      ledger.record("compare_options", false);
      ledger.record("draft_text", false);
      chosen.add(ledger.settle()?.capabilityId ?? "none");
    }
    assert.equal(chosen.size, 1);
  });
});
