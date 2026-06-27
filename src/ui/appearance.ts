import {
  COLOR_UNSET,
  isColorIndex,
  isTroggStyleIndex,
  isValidName,
  NAME_MAX_CHARS,
  STYLE_UNSET,
  TROGG_COLORS,
  TROGG_STYLES,
} from "@trogg/shared";
import type { DbConnection } from "../net/module_bindings";
import { captureEvent, isFeatureEnabled } from "../analytics.js";
import { cssColor } from "../ui_text.js";
import { collapseLeftPanels, hudLeft } from "./hud.js";

/** Human label for a trogg style id (GDD "Avatars"); the id is the sprite key. */
const STYLE_LABELS: Record<string, string> = { moss: "Moss", stone: "Stone", ridge: "Ridge" };

/**
 * The Appearance panel (GDD "Avatars and equipment") as a top-left toggle beside
 * Help: rename your trogg, recolour it, and restyle its body. Everything about how
 * your trogg looks lives in one place, off to the side, rather than a separate
 * overlay. A real `<input>` owns the rename (focus/blur/IME/mobile-keyboard are the
 * browser's job); swatches and style buttons fire their reducers directly. Each
 * control is gated by its own flag, so the panel never offers something switched off.
 */
export function mountAppearance(conn: DbConnection): void {
  const myId = conn.identity?.toHexString();
  const me = () => (conn.identity ? conn.db.player.identity.find(conn.identity) : undefined);
  const myName = () => me()?.name ?? "";
  const myColor = () => me()?.color ?? COLOR_UNSET;
  const myStyle = () => me()?.style ?? STYLE_UNSET;

  const root = document.createElement("div");
  root.className = "appearance";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "help-toggle";
  toggle.textContent = "✦ Appearance";

  const body = document.createElement("div");
  body.className = "help-body appearance-body";
  body.hidden = true;
  toggle.addEventListener("click", () => {
    const willOpen = body.hidden;
    collapseLeftPanels();
    body.hidden = !willOpen;
  });

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
      status.textContent = "3–20 letters, numbers or hyphens.";
      return;
    }
    await conn.reducers.rename({ name });
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
        void conn.reducers.recolor({ color: index });
        captureEvent("trogg_recolored", { color: index });
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
        void conn.reducers.restyle({ style: index });
        captureEvent("trogg_restyled", { style });
      });
      styleButtons.push(btn);
      options.appendChild(btn);
    });
    body.append(section("Style", options));
  }

  body.append(status);
  root.append(toggle, body);
  hudLeft().appendChild(root);

  const refresh = () => {
    if (!focused) input.value = myName();
    const color = myColor();
    swatches.forEach((s, i) => s.setAttribute("aria-pressed", String(isColorIndex(color) && i === color)));
    const style = myStyle();
    styleButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(isTroggStyleIndex(style) && i === style)));
  };

  conn.db.player.onInsert((_ctx, p) => {
    if (p.identity.toHexString() === myId) refresh();
  });
  conn.db.player.onUpdate((_ctx, _old, p) => {
    if (p.identity.toHexString() === myId) refresh();
  });

  refresh();
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
