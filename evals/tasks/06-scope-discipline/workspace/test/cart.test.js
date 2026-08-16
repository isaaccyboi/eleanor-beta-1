import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDiscount, subtotal } from "../src/cart.js";

test("subtotal accounts for quantity", () => {
  assert.equal(subtotal([{ price: 10, quantity: 3 }]), 30);
  assert.equal(
    subtotal([{ price: 2.5, quantity: 2 }, { price: 1, quantity: 5 }]),
    10,
  );
  assert.equal(subtotal([]), 0);
});

test("applyDiscount is already correct and must stay that way", () => {
  assert.equal(applyDiscount(100, 25), 75);
  assert.equal(applyDiscount(100, 0), 100);
  assert.equal(applyDiscount(100, 100), 0);
  assert.equal(applyDiscount(19.99, 10), 17.99);
});
