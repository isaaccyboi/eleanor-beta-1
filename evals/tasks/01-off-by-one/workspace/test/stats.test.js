import { test } from "node:test";
import assert from "node:assert/strict";
import { mean, sum } from "../src/stats.js";

test("sum adds every element", () => {
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(sum([5]), 5);
  assert.equal(sum([]), 0);
});

test("mean divides the total by the count", () => {
  assert.equal(mean([2, 4, 6]), 4);
});
