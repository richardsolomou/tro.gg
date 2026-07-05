import { ITEMS } from "@trogg/shared";
import { itemIcon } from "../game/icons.js";
import type { DbConnection } from "../net/module_bindings";
import type { Stockpile } from "../net/module_bindings/types";
import { hudRoot } from "./hud.js";
import { attachTip } from "./tooltip.js";
import { coachHit } from "./coach.js";

/** Mount the tribe's shared stockpile: a small always-visible, read-only
 *  readout (GDD "The fire and the dark" → The stockpile) — top-centre, never a
 *  toggle, since it belongs to everyone and there's nothing to act on. */
export function mountStockpile(conn: DbConnection): void {
  document.getElementById("stockpile-panel")?.remove();

  const root = document.createElement("div");
  root.id = "stockpile-panel";
  root.className = "stockpile";
  hudRoot().appendChild(root);

  const rows = new Map<string, Stockpile>();

  const render = () => {
    root.replaceChildren();
    const sorted = [...rows.values()].filter((row) => row.qty > 0).sort((a, b) => a.item.localeCompare(b.item));
    for (const row of sorted) {
      const def = ITEMS[row.item as keyof typeof ITEMS];
      const entry = document.createElement("div");
      entry.className = "stockpile-item";
      attachTip(entry, def?.name ?? row.item, "The tribe's shared stockpile");
      entry.appendChild(itemIcon(row.item));
      const qty = document.createElement("span");
      qty.className = "stockpile-qty";
      qty.textContent = String(row.qty);
      entry.appendChild(qty);
      root.appendChild(entry);
    }
    root.hidden = sorted.length === 0;
  };

  // The first-ever stockpile gain of each raw resource teaches what feeds it —
  // the tribe's pool, not a personal pickup, so it fires for anyone's gather,
  // not just the local player's.
  const announceFirstGain = (item: string, grew: boolean) => {
    if (!grew) return;
    if (item === "stone") coachHit("mined-stone");
    if (item === "wood") coachHit("chopped-wood");
  };

  conn.db.stockpile.onInsert((ctx, row) => {
    rows.set(row.item, row);
    render();
    announceFirstGain(row.item, ctx.event.tag !== "SubscribeApplied");
  });
  conn.db.stockpile.onUpdate((ctx, old, row) => {
    rows.set(row.item, row);
    render();
    announceFirstGain(row.item, ctx.event.tag !== "SubscribeApplied" && row.qty > old.qty);
  });
  conn.db.stockpile.onDelete((_ctx, row) => {
    rows.delete(row.item);
    render();
  });

  render();
}
