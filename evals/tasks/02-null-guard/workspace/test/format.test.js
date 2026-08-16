import { test } from "node:test";
import assert from "node:assert/strict";
import { formatName } from "../src/format.js";

test("formats a full name", () => {
  assert.equal(formatName({ first: "Ada", last: "Lovelace" }), "Ada Lovelace");
});

test("returns an empty string when there is no user", () => {
  assert.equal(formatName(null), "");
  assert.equal(formatName(undefined), "");
});
