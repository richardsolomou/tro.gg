import {
  COLOR_UNSET,
  isValidName,
  NAME_MAX_CHARS,
  STYLE_UNSET,
  troggColorIndexFor,
  TROGG_COLORS,
  troggStyleIndexFor,
  TROGG_STYLES,
} from "@trogg/shared";
import type { DbConnection } from "../net/module_bindings";
import { captureEvent, isFeatureEnabled, logError, logInfo, logWarn } from "../analytics.js";
import { signIn } from "../auth.js";
import { setPendingClaim } from "../identity.js";
import { attachTip } from "./tooltip.js";
import { cssColor } from "../ui_text.js";
import { hudIcon } from "../game/icons.js";
import { hudLeft } from "./hud.js";
import { registerKeybind } from "./keybinds.js";
import { recolorTrogg, renameTrogg, restyleTrogg } from "../net/procedures.js";

/** Human label for a trogg style id (GDD "Avatars"). */
const STYLE_LABELS: Record<string, string> = { moss: "Moss", stone: "Stone", ridge: "Ridge" };

/**
 * The Appearance panel (GDD "Avatars and equipment") as a top-left toggle beside
 * Help: rename your trogg, recolour it, and restyle its body. Everything about how
 * your trogg looks lives in one place, off to the side, rather than a separate
 * overlay. A real `<input>` owns the rename (focus/blur/IME/mobile-keyboard are the
 * browser's job); swatches and style buttons use procedure wrappers so accepted
 * server mutations emit analytics. Each control is gated by its own flag, so the panel never offers something switched off.
 */
export interface AppearanceContext {
  signedIn: boolean;
  authAvailable: boolean;
  claimFailed?: boolean;
}

export function mountAppearance(conn: DbConnection, account: AppearanceContext): void {
  const myId = conn.identity?.toHexString();
  const me = () => (conn.identity ? conn.db.player.identity.find(conn.identity) : undefined);
  const myName = () => me()?.name ?? "";
  const myColor = () => me()?.color ?? COLOR_UNSET;
  const myStyle = () => me()?.style ?? STYLE_UNSET;

  const root = document.createElement("div");
  root.className = "appearance";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "hud-icon-button appearance-toggle";
  toggle.setAttribute("aria-label", "Appearance");
  toggle.setAttribute("aria-keyshortcuts", "P");
  attachTip(toggle, "Appearance (P)", "Your name, colour, and build", "below");
  toggle.appendChild(hudIcon("appearance"));

  const body = document.createElement("div");
  body.className = "help-body appearance-body";
  body.hidden = true;
  const setOpen = (open: boolean) => {
    const opening = open && body.hidden;
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", String(!body.hidden));
    if (opening) window.dispatchEvent(new CustomEvent("hud-menu-open", { detail: "appearance" }));
  };
  const toggleOpen = () => setOpen(body.hidden === true);
  toggle.addEventListener("click", toggleOpen);
  registerKeybind({ id: "hud-appearance", matches: (event) => event.code === "KeyP", handler: toggleOpen });
  // Accordion: opening any left-bar menu closes the others, so two drop-downs never overlap.
  window.addEventListener("hud-menu-open", ((event: Event) => {
    if ((event as CustomEvent<string>).detail !== "appearance") setOpen(false);
  }) as EventListener);

  const status = document.createElement("div");
  status.className = "account-status";

  // ── Name ─────────────────────────────────────────────────────────────────────
  const input = document.createElement("input");
  input.className = "field";
  input.type = "text";
  input.maxLength = NAME_MAX_CHARS;
  input.placeholder = "Rename your trogg…";
  let focused = false;

  const rename = async (raw: string) => {
    const name = raw.trim();
    if (!isValidName(name)) {
      logWarn("Rejected invalid rename", { surface: "appearance", reason: "invalid_name" });
      status.textContent = "3–20 letters, numbers or hyphens.";
      return;
    }
    try {
      await renameTrogg(conn, name);
    } catch (err) {
      logError("Rename action failed", { surface: "appearance", action: "rename", error: err });
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
  body.append(section("Name", input));

  // ── Colour ───────────────────────────────────────────────────────────────────
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
        void recolorTrogg(conn, index).catch((err) => {
          logError("Recolor action failed", { surface: "appearance", action: "recolor", color: index, error: err });
          status.textContent = "Couldn't recolour. Try again.";
        });
      });
      swatches.push(swatch);
      palette.appendChild(swatch);
    });
    body.append(section("Colour", palette));
  }

  // ── Style ────────────────────────────────────────────────────────────────────
  const styleButtons: HTMLButtonElement[] = [];
  if (isFeatureEnabled("trogg-restyle")) {
    const options = document.createElement("div");
    options.className = "style-options";
    TROGG_STYLES.forEach((style, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "style-option";
      btn.textContent = STYLE_LABELS[style] ?? style;
      btn.addEventListener("click", () => {
        void restyleTrogg(conn, index).catch((err) => {
          logError("Restyle action failed", { surface: "appearance", action: "restyle", style, error: err });
          status.textContent = "Couldn't restyle. Try again.";
        });
      });
      styleButtons.push(btn);
      options.appendChild(btn);
    });
    body.append(section("Style", options));
  }

  // ── Account ──────────────────────────────────────────────────────────────────
  // Claiming an account (sign in with Discord) lets a guest log back into the
  // same trogg on any device. It lives here beside name/colour — the rest of
  // "who your trogg is" — while Log out lives in the game menu (Esc).
  if (account.authAvailable && !account.signedIn) {
    const claim = document.createElement("button");
    claim.type = "button";
    claim.className = "btn";
    claim.textContent = "Claim account with Discord";
    claim.addEventListener("click", () => startClaim(conn, claim, status));
    if (account.claimFailed) status.textContent = "Sign-in didn't complete. Try again.";
    body.append(section("Account", claim));
  }

  body.append(status);
  root.append(toggle, body);
  hudLeft().appendChild(root);

  const refresh = () => {
    if (!focused) input.value = myName();
    // Highlight the look the trogg actually shows — its chosen entry, or the
    // id-derived default when it hasn't picked one (so a fresh trogg isn't blank).
    const color = troggColorIndexFor(myColor(), myId ?? "");
    swatches.forEach((s, i) => s.setAttribute("aria-pressed", String(i === color)));
    const style = troggStyleIndexFor(myStyle(), myId ?? "");
    styleButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(i === style)));
  };

  conn.db.player.onInsert((_ctx, p) => {
    if (p.identity.toHexString() === myId) refresh();
  });
  conn.db.player.onUpdate((_ctx, _old, p) => {
    if (p.identity.toHexString() === myId) refresh();
  });

  refresh();
}

/** Begin an account claim (GDD "Identity"): register the one-time nonce on the
 *  guest row, then redirect to sign in; the return folds the guest in. */
function startClaim(conn: DbConnection, button: HTMLButtonElement, status: HTMLElement): void {
  void (async () => {
    button.disabled = true;
    status.textContent = "Starting sign-in…";
    const code = crypto.randomUUID();
    try {
      await conn.reducers.startClaim({ code });
    } catch (err) {
      logError("Account claim start failed", { surface: "appearance", action: "start_claim", error: err });
      status.textContent = "Couldn't start sign-in. Try again.";
      button.disabled = false;
      return;
    }
    setPendingClaim(code);
    captureEvent("account_claim_started");
    logInfo("Account claim started", { surface: "appearance" });
    try {
      await signIn();
    } catch (err) {
      logError("Sign-in redirect failed", { surface: "appearance", action: "sign_in_redirect", error: err });
      status.textContent = "Couldn't open sign-in. Try again.";
      button.disabled = false;
    }
  })();
}

/** A labelled block in the panel: a small title above its control. */
function section(title: string, control: HTMLElement): HTMLDivElement {
  const block = document.createElement("div");
  block.className = "appearance-section";
  const label = document.createElement("div");
  label.className = "help-section-title";
  label.textContent = title;
  block.append(label, control);
  return block;
}
