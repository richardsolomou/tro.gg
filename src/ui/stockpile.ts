import { ITEMS, STOCKPILE_ITEM_IDS, type StockpileItemId } from "@trogg/shared";
import { itemIcon } from "../game/icons.js";
import type { DbConnection } from "../net/module_bindings";
import { audio } from "../audio.js";
import { coachHit } from "./coach.js";
import { hudRoot } from "./hud.js";
import { pickupToast } from "./toasts.js";
import { attachTip } from "./tooltip.js";

/** Mount the tribe's shared stockpile readout (GDD "The fire and the dark" → The
 *  stockpile): a small always-visible strip, top-centre — distinct from the
 *  top-left personal HUD toggles, since this is nobody's inventory. Every
 *  stockpile item shows even at zero, so a fresh world never looks broken. */
export function mountStockpile(conn: DbConnection): void {
  document.getElementById("stockpile-strip")?.remove();

  const root = document.createElement("div");
  root.id = "stockpile-strip";
  root.className = "stockpile-strip";
  root.setAttribute("role", "status");

  const rows = new Map<StockpileItemId, { row: HTMLElement; qty: HTMLElement }>();
  for (const item of STOCKPILE_ITEM_IDS) {
    const def = ITEMS[item];
    const row = document.createElement("div");
    row.className = "stockpile-item";
    attachTip(row, def.name, def.blurb, "below");
    row.appendChild(itemIcon(item));
    const qty = document.createElement("span");
    qty.className = "stockpile-qty";
    qty.textContent = "0";
    row.appendChild(qty);
    root.appendChild(row);
    rows.set(item, { row, qty });
  }

  hudRoot().appendChild(root);

  const isStockpileItem = (item: string): item is StockpileItemId => (STOCKPILE_ITEM_IDS as readonly string[]).includes(item);

  const announceGather = (item: StockpileItemId, delta: number) => {
    pickupToast(item, delta);
    audio.playPickup(item);
    if (item === "stone") coachHit("mined-stone");
    if (item === "wood") coachHit("chopped-wood");
  };

  const apply = (item: string, qty: number, delta: number) => {
    if (!isStockpileItem(item)) return;
    const entry = rows.get(item);
    if (!entry) return;
    entry.qty.textContent = String(qty);
    if (delta > 0) announceGather(item, delta);
  };

  // Fresh diffs only (never the boot snapshot), matching inventory.ts's
  // announcePickup guard — the initial subscribe delivers what's already
  // there, not something just gathered.
  conn.db.stockpile.onInsert((ctx, row) => {
    apply(row.item, row.qty, ctx.event.tag !== "SubscribeApplied" ? row.qty : 0);
  });
  conn.db.stockpile.onUpdate((ctx, old, row) => {
    apply(row.item, row.qty, ctx.event.tag !== "SubscribeApplied" ? row.qty - old.qty : 0);
  });
}
