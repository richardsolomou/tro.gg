import { COLOR_UNSET, isColorIndex, isValidName, NAME_MAX_CHARS, TROGG_COLORS } from "@trogg/shared";
import type { DbConnection } from "../net/module_bindings";
import { captureEvent, captureException, captureLog, isFeatureEnabled } from "../analytics.js";
import { signIn, signOut } from "../auth.js";
import { setPendingClaim } from "../identity.js";
import { cssColor } from "../ui_text.js";
import { hudRoot } from "./hud.js";

/**
 * The account panel (GDD "Identity") as an HTML overlay: rename your trogg,
 * recolour it, and claim an account when auth is configured. A real `<input>`
 * owns the rename, so focus/blur/IME/mobile-keyboard are the browser's job.
 */
export function mountAccount(conn: DbConnection, opts: { signedIn: boolean; authAvailable: boolean }): void {
  const myId = conn.identity?.toHexString();
  const myName = () => (conn.identity ? (conn.db.player.identity.find(conn.identity)?.name ?? "") : "");
  const myColor = () => (conn.identity ? (conn.db.player.identity.find(conn.identity)?.color ?? COLOR_UNSET) : COLOR_UNSET);

  const root = document.createElement("div");
  root.className = "panel account";

  const who = document.createElement("div");
  const input = document.createElement("input");
  input.className = "field";
  input.type = "text";
  input.maxLength = NAME_MAX_CHARS;
  input.placeholder = "Rename your trogg...";
  const status = document.createElement("div");
  status.className = "account-status";
  root.append(who, input, status);

  const swatches: HTMLButtonElement[] = [];
  if (isFeatureEnabled("trogg-recolor")) {
    const palette = document.createElement("div");
    palette.className = "swatches";
    TROGG_COLORS.forEach((color, index) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "swatch";
      swatch.style.background = cssColor(color);
      swatch.setAttribute("aria-label", `Trogg colour ${index + 1}`);
      swatch.addEventListener("click", () => {
        void conn.reducers.recolor({ color: index });
        captureEvent("trogg_recolored", { color: index });
      });
      swatches.push(swatch);
      palette.appendChild(swatch);
    });
    root.appendChild(palette);
  }

  if (opts.authAvailable) {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "btn";
    action.textContent = opts.signedIn ? "Sign out" : "Claim account with Discord";
    action.addEventListener("click", async () => {
      if (opts.signedIn) {
        captureEvent("account_signed_out");
        captureLog("info", "Account signed out", { surface: "account" });
        await signOut();
        window.location.reload();
        return;
      }
      action.disabled = true;
      status.textContent = "Starting sign-in...";
      const code = crypto.randomUUID();
      try {
        await conn.reducers.startClaim({ code });
      } catch (err) {
        captureException(err, { surface: "account", action: "start_claim" });
        captureLog("warn", "Account claim start failed", { surface: "account" });
        status.textContent = "Couldn't start sign-in. Try again.";
        action.disabled = false;
        return;
      }
      setPendingClaim(code);
      captureEvent("account_claim_started");
      captureLog("info", "Account claim started", { surface: "account" });
      try {
        await signIn();
      } catch (err) {
        captureException(err, { surface: "account", action: "sign_in_redirect" });
        captureLog("error", "Sign-in redirect failed", { surface: "account" });
        status.textContent = "Couldn't open sign-in. Try again.";
        action.disabled = false;
      }
    });
    root.appendChild(action);
  }

  hudRoot().appendChild(root);

  let focused = false;

  const rename = async (raw: string) => {
    const name = raw.trim();
    if (!isValidName(name)) {
      captureLog("warn", "Rejected invalid rename", { surface: "account", reason: "invalid_name" });
      status.textContent = "3-20 letters, numbers or hyphens.";
      return;
    }
    try {
      await conn.reducers.rename({ name });
    } catch (err) {
      captureException(err, { surface: "account", action: "rename" });
      captureLog("error", "Rename reducer failed", { surface: "account" });
      status.textContent = "Couldn't rename. Try again.";
      return;
    }
    status.textContent = myName() === name ? "Saved." : "That name's taken.";
    refresh();
  };

  input.addEventListener("focus", () => {
    focused = true;
    if (!input.value) input.value = myName();
  });
  input.addEventListener("blur", () => {
    focused = false;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void rename(input.value);
      input.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.value = myName();
      input.blur();
    }
  });

  const refresh = () => {
    const name = myName();
    who.textContent = name ? `You are ${name}` : "Connecting...";
    if (!focused) input.value = name;
    const color = myColor();
    swatches.forEach((swatch, i) => swatch.setAttribute("aria-pressed", String(isColorIndex(color) && i === color)));
  };

  conn.db.player.onInsert((_ctx, p) => {
    if (p.identity.toHexString() === myId) refresh();
  });
  conn.db.player.onUpdate((_ctx, _old, p) => {
    if (p.identity.toHexString() === myId) refresh();
  });

  refresh();
}
