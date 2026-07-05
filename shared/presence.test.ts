import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "spacetimedb";
import {
  KINDLING_ACTIVITY_WINDOW_MS,
  KINDLING_CHARGE_MAX_MS,
  derivedKindlingCharge,
  presenceState,
} from "./index";

const at = (ms: number) => new Timestamp(BigInt(ms) * 1000n);

test("bright activity accrues only through the recent input window", () => {
  const state = { online: true, kindlingCharge: 1_000, kindlingChargeAt: at(0) };
  assert.equal(derivedKindlingCharge(state, at(5_000)), 6_000);
  assert.equal(derivedKindlingCharge(state, at(KINDLING_ACTIVITY_WINDOW_MS * 10)), 1_000 + KINDLING_ACTIVITY_WINDOW_MS);
});

test("kindling charge is capped and decays in real time while offline", () => {
  assert.equal(
    derivedKindlingCharge({ online: true, kindlingCharge: KINDLING_CHARGE_MAX_MS, kindlingChargeAt: at(0) }, at(10_000)),
    KINDLING_CHARGE_MAX_MS,
  );
  assert.equal(derivedKindlingCharge({ online: false, kindlingCharge: 10_000, kindlingChargeAt: at(0) }, at(4_000)), 6_000);
  assert.equal(derivedKindlingCharge({ online: false, kindlingCharge: 10_000, kindlingChargeAt: at(0) }, at(11_000)), 0);
});

test("presence is derived from connection and charge", () => {
  assert.equal(presenceState({ online: true, kindlingCharge: 0, kindlingChargeAt: at(0) }, at(0)), "bright");
  assert.equal(presenceState({ online: false, kindlingCharge: 1, kindlingChargeAt: at(0) }, at(0)), "ember");
  assert.equal(presenceState({ online: false, kindlingCharge: 1, kindlingChargeAt: at(0) }, at(2)), "dormant");
});
