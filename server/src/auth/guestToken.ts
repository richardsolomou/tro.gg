import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Self-issued guest credentials (GDD "Identity"): the server mints a signed
 * token binding a generated user id, the browser stores it, and `onAuth`
 * verifies the signature before a client may join — never trusting a
 * client-supplied id (invariant 3). HMAC-SHA256 over the id is enough; guest
 * tokens carry no expiry, so a returning visitor resumes the same trogg until
 * they clear the browser. Accounts (cross-device sign-in, real names) are the
 * next slice of M1 and build on this.
 */

let secret: Buffer | null = null;

/**
 * The HMAC key. Prefers AUTH_SECRET; without it (a bare dev checkout, invariant
 * 6) we fall back to an ephemeral key, so guest tokens simply don't survive a
 * restart. Never commit a secret (invariant 8).
 */
function key(): Buffer {
  if (secret) return secret;
  const fromEnv = process.env.AUTH_SECRET;
  if (fromEnv) {
    secret = Buffer.from(fromEnv, "utf8");
  } else {
    console.warn(
      "AUTH_SECRET not set — using an ephemeral key; guest credentials won't survive a server restart. Set AUTH_SECRET for durable identity.",
    );
    secret = randomBytes(32);
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", key()).update(payload).digest("base64url");
}

/** A signed credential vouching for `userId`. */
export function mintGuestToken(userId: string): string {
  const payload = Buffer.from(userId, "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The user id a token vouches for, or null if it's missing, malformed, or forged. */
export function verifyGuestToken(token: string | undefined): string | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, sign(payload))) return null;

  return Buffer.from(payload, "base64url").toString("utf8") || null;
}

/** Constant-time string compare that tolerates length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
