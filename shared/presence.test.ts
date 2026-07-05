import assert from "node:assert/strict";
import { test } from "node:test";
import { CHARGE_ACCRUAL_RATE, CHARGE_DECAY_RATE, CHARGE_MAX_MS } from "./constants";
import { kindlingChargeNow, presenceOf } from "./presence";

const stamp = (ms: number) => ({ microsSinceUnixEpoch: BigInt(ms) * 1000n });

test("charge accrues at CHARGE_ACCRUAL_RATE while online", () => {
  const row = { online: true, kindlingCharge: 0, kindlingChargeAt: stamp(0) };
  assert.equal(kindlingChargeNow(row, stamp(1000)), 1000 * CHARGE_ACCRUAL_RATE);
});

test("charge decays at CHARGE_DECAY_RATE while offline", () => {
  const row = { online: false, kindlingCharge: 500, kindlingChargeAt: stamp(0) };
  assert.equal(kindlingChargeNow(row, stamp(200)), 500 - 200 * CHARGE_DECAY_RATE);
});

test("offline charge floors at zero, never goes negative", () => {
  const row = { online: false, kindlingCharge: 50, kindlingChargeAt: stamp(0) };
  assert.equal(kindlingChargeNow(row, stamp(10_000)), 0);
});

test("online charge caps at CHARGE_MAX_MS, never overshoots", () => {
  const row = { online: true, kindlingCharge: CHARGE_MAX_MS - 10, kindlingChargeAt: stamp(0) };
  assert.equal(kindlingChargeNow(row, stamp(1_000_000)), CHARGE_MAX_MS);
});

test("presenceOf is bright whenever online, regardless of banked charge", () => {
  const row = { online: true, kindlingCharge: 0, kindlingChargeAt: stamp(0) };
  assert.equal(presenceOf(row, stamp(0)), "bright");
});

test("presenceOf is ember offline with charge remaining", () => {
  const row = { online: false, kindlingCharge: 1000, kindlingChargeAt: stamp(0) };
  assert.equal(presenceOf(row, stamp(10)), "ember");
});

test("presenceOf is dormant offline once charge runs dry", () => {
  const row = { online: false, kindlingCharge: 100, kindlingChargeAt: stamp(0) };
  const dryAt = stamp(100 / CHARGE_DECAY_RATE + 1);
  assert.equal(presenceOf(row, dryAt), "dormant");
});
