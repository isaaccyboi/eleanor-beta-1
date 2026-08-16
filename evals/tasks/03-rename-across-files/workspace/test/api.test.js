import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchUser } from "../src/user.js";
import { profileLine } from "../src/profile.js";
import { isAdmin } from "../src/admin.js";

test("fetchUser returns the user record", () => {
  assert.equal(fetchUser(1).name, "Ada");
  assert.equal(fetchUser(99), null);
});

test("callers keep working after the rename", () => {
  assert.equal(profileLine(2), "Profile: Grace");
  assert.equal(profileLine(99), "Profile: unknown");
  assert.equal(isAdmin(1), true);
  assert.equal(isAdmin(2), false);
});
