import { ITEMS } from "@trogg/shared";
import { itemIcon } from "../game/icons.js";
import { hudRoot } from "./hud.js";

/** How long a toast holds before fading, and how long the fade runs (matches
 *  the .pickup-toast.is-leaving transition in hud.css). */
const HOLD_MS = 2400;
const LEAVE_MS = 250;

interface ActiveToast {
  el: HTMLElement;
  count: HTMLElement;
  qty: number;
  timer: number;
}

const active = new Map<string, ActiveToast>();
let rack: HTMLElement | undefined;

function rackEl(): HTMLElement {
  if (!rack) {
    rack = document.createElement("div");
    rack.className = "pickup-toasts";
    rack.setAttribute("role", "status");
    rack.setAttribute("aria-live", "polite");
    hudRoot().appendChild(rack);
  }
  return rack;
}

function dismissLater(item: string, el: HTMLElement): number {
  return window.setTimeout(() => {
    active.delete(item);
    el.classList.add("is-leaving");
    window.setTimeout(() => el.remove(), LEAVE_MS);
  }, HOLD_MS);
}

/** A pickup toast — the item's icon and name, bottom centre. One card per item
 *  id: rapid pickups (a radius-`E` gather sweeping a pile) bump the card's
 *  count and its clock instead of stacking duplicates. */
export function pickupToast(item: string, qty: number): void {
  const entry = active.get(item);
  if (entry) {
    entry.qty += qty;
    entry.count.textContent = `×${entry.qty}`;
    entry.count.hidden = false;
    window.clearTimeout(entry.timer);
    entry.timer = dismissLater(item, entry.el);
    return;
  }
  const el = document.createElement("div");
  el.className = "pickup-toast";
  const name = document.createElement("span");
  name.className = "pickup-toast-name";
  name.textContent = ITEMS[item as keyof typeof ITEMS]?.name ?? item;
  const count = document.createElement("span");
  count.className = "pickup-toast-qty";
  count.textContent = `×${qty}`;
  count.hidden = qty <= 1;
  el.append(itemIcon(item), name, count);
  rackEl().appendChild(el);
  active.set(item, { el, count, qty, timer: dismissLater(item, el) });
}
