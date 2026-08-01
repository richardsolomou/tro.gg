import assert from "node:assert/strict";
import test from "node:test";
import { connectWithGuestTokenFallback, isTokenVerificationError } from "./net/connection-error.js";

test("recognizes a rejected SpacetimeDB token", () => {
  assert.equal(isTokenVerificationError(new Error("Failed to verify token: Unauthorized")), true);
});

test("does not treat a network failure as a rejected token", () => {
  assert.equal(isTokenVerificationError(new Error("WebSocket connection failed")), false);
});

test("does not treat a non-error value as a rejected token", () => {
  assert.equal(isTokenVerificationError("Failed to verify token"), false);
});

test("retries a rejected stored guest token anonymously", async () => {
  const tokens: Array<string | undefined> = [];
  const result = await connectWithGuestTokenFallback("stale", async (token) => {
    tokens.push(token);
    if (token) throw new Error("Failed to verify token: Unauthorized");
    return "connected";
  });

  assert.deepEqual({ result, tokens }, { result: "connected", tokens: ["stale", undefined] });
});

test("does not retry another connection failure anonymously", async () => {
  let attempts = 0;

  await assert.rejects(
    connectWithGuestTokenFallback("valid", async () => {
      attempts++;
      throw new Error("WebSocket connection failed");
    }),
    /WebSocket connection failed/,
  );
  assert.equal(attempts, 1);
});
