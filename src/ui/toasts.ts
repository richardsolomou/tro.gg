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

function dismissLater(key: string, el: HTMLElement): number {
  return window.setTimeout(() => {
    active.delete(key);
    el.classList.add("is-leaving");
    window.setTimeout(() => el.remove(), LEAVE_MS);
  }, HOLD_MS);
}

/** Coalesce rapid gains of the same item and destination into one toast. */
function itemToast(item: string, qty: number, destination: "pack" | "stockpile"): void {
  const key = `${destination}:${item}`;
  const entry = active.get(key);
  if (entry) {
    entry.qty += qty;
    entry.count.textContent = `×${entry.qty}`;
    entry.count.hidden = false;
    window.clearTimeout(entry.timer);
    entry.timer = dismissLater(key, entry.el);
    return;
  }
  const el = document.createElement("div");
  el.className = "pickup-toast";
  const name = document.createElement("span");
  name.className = "pickup-toast-name";
  const itemName = ITEMS[item as keyof typeof ITEMS]?.name ?? item;
  name.textContent = destination === "stockpile" ? `${itemName} to the Stockpile` : itemName;
  const count = document.createElement("span");
  count.className = "pickup-toast-qty";
  count.textContent = `×${qty}`;
  count.hidden = qty <= 1;
  el.append(itemIcon(item), name, count);
  rackEl().appendChild(el);
  active.set(key, { el, count, qty, timer: dismissLater(key, el) });
}

export function pickupToast(item: string, qty: number): void {
  itemToast(item, qty, "pack");
}

export function stockpileToast(item: string, qty: number): void {
  itemToast(item, qty, "stockpile");
}
