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
import { isFeatureEnabled, logError, logWarn } from "../analytics.js";
import { cssColor } from "../ui_text.js";
import { hudLeft } from "./hud.js";
import { registerKeybind } from "./keybinds.js";
import { recolorTrogg, renameTrogg, restyleTrogg } from "../net/procedures.js";

/** Human label for a trogg style id (GDD "Avatars"); the id is the sprite key. */
const STYLE_LABELS: Record<string, string> = { moss: "Moss", stone: "Stone", ridge: "Ridge" };

/**
 * The Appearance panel (GDD "Avatars and equipment") as a top-left toggle beside
 * Help: rename your trogg, recolour it, and restyle its body. Everything about how
 * your trogg looks lives in one place, off to the side, rather than a separate
 * overlay. A real `<input>` owns the rename (focus/blur/IME/mobile-keyboard are the
 * browser's job); swatches and style buttons use procedure wrappers so accepted
 * server mutations emit analytics. Each control is gated by its own flag, so the panel never offers something switched off.
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
  toggle.className = "hud-icon-button appearance-toggle";
  toggle.setAttribute("aria-label", "Appearance");
  toggle.setAttribute("aria-keyshortcuts", "P");
  toggle.title = "Appearance (P)";
  toggle.appendChild(appearanceIcon());

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

function svg(width: number, height: number): SVGSVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", `0 0 ${width} ${height}`);
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("focusable", "false");
  return node;
}

function el(name: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function appearanceIcon(): SVGSVGElement {
  const icon = svg(24, 24);
  icon.append(
    el("path", { d: "M12 4l2.1 4.9L19 11l-4.9 2.1L12 18l-2.1-4.9L5 11l4.9-2.1L12 4Z", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linejoin": "round" }),
    el("path", { d: "M18 4l.8 1.9L21 7l-2.2 1.1L18 10l-.8-1.9L15 7l2.2-1.1L18 4Z", fill: "currentColor" }),
  );
  return icon;
}
