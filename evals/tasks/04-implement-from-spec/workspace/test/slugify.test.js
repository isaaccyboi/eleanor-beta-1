import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.js";

test("lowercases and joins words with dashes", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("strips punctuation", () => {
  assert.equal(slugify("It's a Test!"), "its-a-test");
});

test("collapses runs of separators into one dash", () => {
  assert.equal(slugify("a   b---c"), "a-b-c");
});

test("trims leading and trailing separators", () => {
  assert.equal(slugify("  --Hello--  "), "hello");
});

test("returns an empty string when nothing survives", () => {
  assert.equal(slugify(""), "");
  assert.equal(slugify("!!!"), "");
});
