import { hudRoot } from "./hud.js";

/**
 * The one floating tooltip every HUD control shares: a bold name and an
 * optional blurb, shown on hover or keyboard focus. It floats in the HUD root
 * because it can't live inside the controls — their facet clip-path would crop
 * it, and the Commands drawer's transform would break fixed positioning from
 * within — and is placed against the anchor's rect per call site (a top-left
 * toggle drops it below, the right-edge drawer throws it left).
 */
export type TipPlacement = "right" | "left" | "below";

let tip: HTMLDivElement | undefined;
let tipName: HTMLSpanElement;
let tipBlurb: HTMLSpanElement;

function tipEl(): HTMLDivElement {
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "hud-tip";
    tip.className = "hud-tip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    tipName = document.createElement("span");
    tipName.className = "hud-tip-name";
    tipBlurb = document.createElement("span");
    tipBlurb.className = "hud-tip-blurb";
    tip.append(tipName, tipBlurb);
    hudRoot().appendChild(tip);
  }
  return tip;
}

export function hideTip(): void {
  if (tip) tip.hidden = true;
}

/** Give a control the shared tooltip (replacing any native `title`). */
export function attachTip(el: HTMLElement, name: string, blurb = "", placement: TipPlacement = "right"): void {
  el.removeAttribute("title");
  el.setAttribute("aria-describedby", "hud-tip");
  const show = () => {
    const t = tipEl();
    tipName.textContent = name;
    tipBlurb.textContent = blurb;
    tipBlurb.hidden = blurb === "";
    // measure invisibly first, then place and clamp — the preferred side is a
    // hint; the tooltip must always land fully inside the viewport
    t.style.visibility = "hidden";
    t.hidden = false;
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    const rect = el.getBoundingClientRect();
    let x: number;
    let y: number;
    if (placement === "below") {
      x = rect.left + rect.width / 2 - w / 2;
      y = rect.bottom + 10;
    } else if (placement === "left") {
      x = rect.left - 10 - w;
      y = rect.top + rect.height / 2 - h / 2;
    } else {
      x = rect.right + 10;
      y = rect.top + rect.height / 2 - h / 2;
    }
    t.style.left = `${Math.round(Math.max(8, Math.min(x, window.innerWidth - w - 8)))}px`;
    t.style.top = `${Math.round(Math.max(8, Math.min(y, window.innerHeight - h - 8)))}px`;
    t.style.visibility = "";
  };
  el.addEventListener("mouseenter", show);
  el.addEventListener("mouseleave", hideTip);
  el.addEventListener("focus", show);
  el.addEventListener("blur", hideTip);
}
