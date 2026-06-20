process.env.AUTH_SECRET = "test-secret-key";

import assert from "node:assert/strict";
import { test } from "node:test";
import { mintGuestToken, verifyGuestToken } from "./guestToken.js";

test("a minted token verifies back to its user id", () => {
  const token = mintGuestToken("user-123");
  assert.equal(verifyGuestToken(token), "user-123");
});

test("distinct user ids mint distinct tokens", () => {
  assert.notEqual(mintGuestToken("a"), mintGuestToken("b"));
});

test("a tampered signature is rejected", () => {
  const token = mintGuestToken("user-123");
  const forged = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  assert.equal(verifyGuestToken(forged), null);
});

test("a tampered payload is rejected", () => {
  const [, signature] = mintGuestToken("user-123").split(".");
  const forged = `${Buffer.from("user-999", "utf8").toString("base64url")}.${signature}`;
  assert.equal(verifyGuestToken(forged), null);
});

test("malformed and empty credentials are rejected", () => {
  assert.equal(verifyGuestToken("not-a-token"), null);
  assert.equal(verifyGuestToken(".sig"), null);
  assert.equal(verifyGuestToken(""), null);
  assert.equal(verifyGuestToken(undefined), null);
});
