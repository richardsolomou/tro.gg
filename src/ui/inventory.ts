import { INVENTORY_SLOT_COUNT, ITEMS, isEquippableItem } from "@trogg/shared";
import { logError } from "../analytics.js";
import type { DbConnection } from "../net/module_bindings";
import type { Inventory, Player } from "../net/module_bindings/types";
import { equipItem } from "../net/procedures.js";
import { hudLeft } from "./hud.js";
import { registerKeybind } from "./keybinds.js";

/** Mount the compact inventory/equipment panel. Rows are driven by subscribed inventory state. */
export function mountInventory(conn: DbConnection, playerId: string): void {
  document.getElementById("inventory-panel")?.remove();

  const root = document.createElement("div");
  root.id = "inventory-panel";
  root.className = "inventory";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "hud-icon-button inventory-toggle";
  toggle.setAttribute("aria-label", "Inventory");
  toggle.setAttribute("aria-keyshortcuts", "I");
  toggle.title = "Inventory (I)";
  toggle.appendChild(inventoryIcon());

  const body = document.createElement("div");
  body.className = "inventory-body";
  body.hidden = true;

  const equipped = document.createElement("div");
  equipped.className = "inventory-equipped";

  const list = document.createElement("div");
  list.className = "inventory-list";

  body.append(equipped, list);
  root.append(toggle, body);
  hudLeft().appendChild(root);

  const rows = new Map<string, Inventory>();
  let mainHand = "";
  let mainHandInventoryId = 0n;

  const setOpen = (open: boolean) => {
    const opening = open && body.hidden;
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", String(!body.hidden));
    if (opening) window.dispatchEvent(new CustomEvent("hud-menu-open", { detail: "inventory" }));
  };
  const toggleOpen = () => setOpen(body.hidden === true);
  toggle.addEventListener("click", toggleOpen);
  registerKeybind({ id: "hud-inventory", matches: (event) => event.code === "KeyI", handler: toggleOpen });
  window.addEventListener("hud-menu-open", ((event: Event) => {
    if ((event as CustomEvent<string>).detail !== "inventory") setOpen(false);
  }) as EventListener);

  const render = () => {
    equipped.replaceChildren();
    const equippedLabel = document.createElement("span");
    equippedLabel.textContent = "Main hand";
    const equippedSlot = document.createElement("span");
    equippedSlot.className = "inventory-equipped-slot";
    equippedSlot.title = mainHand ? (ITEMS[mainHand as keyof typeof ITEMS]?.name ?? mainHand) : "Empty";
    equippedSlot.setAttribute("aria-label", equippedSlot.title);
    equippedSlot.appendChild(itemIcon(mainHand || "empty"));
    equipped.append(equippedLabel, equippedSlot);

    list.replaceChildren();

    const sorted = [...rows.values()].sort((a, b) => a.item.localeCompare(b.item) || Number(a.id - b.id));

    for (const row of sorted) {
      const def = ITEMS[row.item as keyof typeof ITEMS];
      const item = document.createElement("button");
      item.type = "button";
      item.className = "inventory-item";
      const equippedNow = row.id === mainHandInventoryId;
      item.setAttribute("aria-label", `${equippedNow ? "Unequip" : "Equip"} ${def?.name ?? row.item}`);
      item.setAttribute("aria-pressed", String(equippedNow));
      item.title = def?.name ?? row.item;
      item.disabled = !isEquippableItem(row.item);
      item.appendChild(itemIcon(row.item));

      if (row.qty > 1) {
        const qty = document.createElement("span");
        qty.className = "inventory-qty";
        qty.textContent = `x${row.qty}`;
        item.appendChild(qty);
      }
      item.addEventListener("click", () => {
        void equipItem(conn, equippedNow ? 0n : row.id).catch((err) => {
          logError("Equip item request failed", { surface: "inventory", action: "equip_item", item: row.item, error: err });
        });
      });

      list.appendChild(item);
    }

    for (let index = sorted.length; index < INVENTORY_SLOT_COUNT; index++) {
      const empty = document.createElement("span");
      empty.className = "inventory-item inventory-slot-empty";
      empty.setAttribute("role", "img");
      empty.setAttribute("aria-label", "Empty inventory slot");
      empty.title = "Empty";
      list.appendChild(empty);
    }
  };

  const mine = (row: Inventory) => row.playerId.toHexString() === playerId;
  conn.db.inventory.onInsert((_ctx, row) => {
    if (!mine(row)) return;
    rows.set(row.id.toString(), row);
    render();
  });
  conn.db.inventory.onUpdate((_ctx, _old, row) => {
    if (!mine(row)) return;
    rows.set(row.id.toString(), row);
    render();
  });
  conn.db.inventory.onDelete((_ctx, row) => {
    if (!mine(row)) return;
    rows.delete(row.id.toString());
    render();
  });

  const applyPlayer = (p: Player) => {
    if (p.identity.toHexString() !== playerId) return;
    mainHand = p.equippedMainHand;
    mainHandInventoryId = p.equippedMainHandInventoryId;
    render();
  };
  conn.db.player.onInsert((_ctx, p) => applyPlayer(p));
  conn.db.player.onUpdate((_ctx, _old, p) => applyPlayer(p));

  render();
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

function inventoryIcon(): SVGSVGElement {
  const icon = svg(24, 24);
  icon.append(
    el("path", { d: "M8 8V6c0-2.2 1.6-4 4-4s4 1.8 4 4v2", fill: "none", stroke: "#0a0806", "stroke-width": 2, "stroke-linecap": "round" }),
    el("path", { d: "M5 8h14l-1 13H6L5 8Z", fill: "#e8dcc4", stroke: "#0a0806", "stroke-width": 2, "stroke-linejoin": "round" }),
    el("path", { d: "M8 12h8", fill: "none", stroke: "#0a0806", "stroke-width": 2, "stroke-linecap": "round" }),
  );
  return icon;
}

export function itemIcon(item: string): SVGSVGElement {
  const icon = svg(32, 32);
  icon.classList.add("item-icon");

  if (item === "pickaxe") {
    icon.append(
      el("line", { x1: 16, y1: 25, x2: 16, y2: 10, stroke: "#6b3f24", "stroke-width": 4, "stroke-linecap": "round" }),
      el("line", { x1: 7, y1: 9, x2: 25, y2: 9, stroke: "#aec4c8", "stroke-width": 4, "stroke-linecap": "round" }),
      el("line", { x1: 10, y1: 7, x2: 22, y2: 7, stroke: "#e8dcc4", "stroke-width": 2, "stroke-linecap": "round" }),
    );
  } else if (item === "shovel") {
    icon.append(
      el("line", { x1: 16, y1: 25, x2: 16, y2: 10, stroke: "#6b3f24", "stroke-width": 4, "stroke-linecap": "round" }),
      el("ellipse", { cx: 16, cy: 8, rx: 7, ry: 5, fill: "#c79b56", stroke: "#2a2118", "stroke-width": 2 }),
    );
  } else if (item === "sword") {
    icon.append(
      el("line", { x1: 16, y1: 24, x2: 16, y2: 7, stroke: "#dce9ee", "stroke-width": 4, "stroke-linecap": "round" }),
      el("line", { x1: 9, y1: 19, x2: 23, y2: 19, stroke: "#f2c94c", "stroke-width": 4, "stroke-linecap": "round" }),
      el("line", { x1: 16, y1: 20, x2: 16, y2: 27, stroke: "#6b3f24", "stroke-width": 4, "stroke-linecap": "round" }),
    );
  } else if (item === "stone") {
    icon.append(
      el("path", { d: "M7 17c0-5 4-9 10-9 5 0 8 3 8 8 0 6-4 9-10 9-5 0-8-3-8-8Z", fill: "#6b5640", stroke: "#2a2118", "stroke-width": 2, "stroke-linejoin": "round" }),
      el("path", { d: "M11 14c2-2 5-3 9-2", fill: "none", stroke: "#8a7257", "stroke-width": 2, "stroke-linecap": "round" }),
    );
  } else {
    icon.append(el("rect", { x: 10, y: 10, width: 12, height: 12, rx: 2, fill: "#2a2118", stroke: "#9b8a6c", "stroke-width": 2 }));
  }
  return icon;
}
