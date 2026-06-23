import { isValidName, NAME_MAX_CHARS } from "@trogg/shared";
import type { DbConnection } from "./module_bindings";
import { signIn, signOut } from "./auth.js";
import { setPendingClaim } from "./identity.js";

/**
 * The account panel (GDD "Identity"): rename your trogg, and — for a guest —
 * claim an account so you can log back in on any device. Sits top-right, styled
 * like the chat panel; mounted only behind the `auth-enabled` flag.
 *
 * Renaming and claiming are server-authoritative (invariant 3): the panel calls
 * the `rename` / `startClaim` reducers and reflects the result from the synced
 * `player` row, never asserting state itself. Claiming generates a one-time nonce,
 * registers it under the guest identity, then redirects to SpacetimeAuth; on
 * return the nonce is redeemed as the account (see main.ts).
 */
export function mountAccount(conn: DbConnection, opts: { signedIn: boolean }): void {
  const myId = conn.identity?.toHexString();
  const myName = () => (conn.identity ? (conn.db.player.identity.find(conn.identity)?.name ?? "") : "");

  const root = el("div", {
    position: "fixed",
    top: "12px",
    right: "12px",
    width: "260px",
    maxWidth: "calc(100vw - 24px)",
    font: "13px/1.45 monospace",
    color: "#e8dcc4",
    background: "rgba(10, 8, 6, 0.55)",
    borderRadius: "4px",
    padding: "8px 10px",
    zIndex: "10",
  });

  const who = el("div", { marginBottom: "6px" });
  const input = document.createElement("input");
  input.maxLength = NAME_MAX_CHARS;
  input.placeholder = "Rename your trogg…";
  Object.assign(input.style, {
    width: "100%",
    boxSizing: "border-box",
    padding: "6px 8px",
    font: "inherit",
    color: "#e8dcc4",
    background: "rgba(10, 8, 6, 0.8)",
    border: "1px solid #2a2118",
    borderRadius: "4px",
    outline: "none",
    marginBottom: "6px",
  } satisfies Partial<CSSStyleDeclaration>);

  const status = el("div", { minHeight: "1.2em", color: "#9b8a6c" });

  const rename = async () => {
    const name = input.value.trim();
    if (!isValidName(name)) {
      status.textContent = "3–20 letters, numbers or hyphens.";
      return;
    }
    await conn.reducers.rename({ name });
    // The reducer is a no-op if the name is taken; trust the synced row, not the call.
    status.textContent = myName() === name ? "Saved." : "That name's taken.";
    refresh();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void rename();
    else if (e.key === "Escape") input.blur();
  });

  root.append(who, input, status);

  if (opts.signedIn) {
    const out = button("Sign out", async () => {
      await signOut();
      window.location.reload();
    });
    root.append(out);
  } else {
    const claim = button("Claim account with Discord", async (btn) => {
      btn.disabled = true;
      status.textContent = "Starting sign-in…";
      const code = crypto.randomUUID();
      try {
        // Register the nonce under our guest identity and wait for the server to
        // ack it before navigating away — otherwise the redirect could cut off the
        // message and the claim would be lost.
        await conn.reducers.startClaim({ code });
      } catch {
        status.textContent = "Couldn't start sign-in. Try again.";
        btn.disabled = false;
        return;
      }
      setPendingClaim(code);
      await signIn();
    });
    root.append(claim);
  }

  document.body.appendChild(root);

  const refresh = () => {
    const name = myName();
    who.textContent = name ? `You are ${name}` : "Connecting…";
    if (document.activeElement !== input) input.value = name;
  };
  conn.db.player.onInsert((_ctx, p) => {
    if (p.identity.toHexString() === myId) refresh();
  });
  conn.db.player.onUpdate((_ctx, _old, p) => {
    if (p.identity.toHexString() === myId) refresh();
  });
  refresh();
}

/** A styled button that disables nothing but passes itself to the async handler. */
function button(label: string, onClick: (btn: HTMLButtonElement) => void | Promise<void>): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = label;
  Object.assign(btn.style, {
    width: "100%",
    padding: "6px 8px",
    font: "inherit",
    color: "#0a0806",
    background: "#e8dcc4",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  btn.addEventListener("click", () => void onClick(btn));
  return btn;
}

/** A div with the given inline styles applied. */
function el(tag: "div", style: Partial<CSSStyleDeclaration>): HTMLDivElement {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  return node;
}
