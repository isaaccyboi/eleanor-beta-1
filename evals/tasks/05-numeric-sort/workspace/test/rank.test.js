import { test } from "node:test";
import assert from "node:assert/strict";
import { sortScores, topScore } from "../src/rank.js";

test("sorts numerically, not lexicographically", () => {
  assert.deepEqual(sortScores([10, 2, 100]), [2, 10, 100]);
  assert.deepEqual(sortScores([5, 5, 1]), [1, 5, 5]);
});

test("does not mutate the caller's array", () => {
  const input = [3, 1, 2];
  sortScores(input);
  assert.deepEqual(input, [3, 1, 2]);
});

test("topScore returns the largest value", () => {
  assert.equal(topScore([10, 2, 100]), 100);
  assert.equal(topScore([]), null);
});
