import { equipSlotOf, INVENTORY_SLOT_COUNT, ITEMS, isEquippableItem } from "@trogg/shared";
import { itemIcon } from "../game/icons.js";
import { logError } from "../analytics.js";
import type { DbConnection } from "../net/module_bindings";
import type { Inventory, Player } from "../net/module_bindings/types";
import { discardItem, dropItem, equipItem } from "../net/procedures.js";
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

  const actions = document.createElement("div");
  actions.className = "inventory-actions";
  actions.hidden = true;

  body.append(equipped, list, actions);
  root.append(toggle, body);
  hudLeft().appendChild(root);

  const rows = new Map<string, Inventory>();
  let mainHand = "";
  let mainHandInventoryId = 0n;
  let offHand = "";
  let offHandInventoryId = 0n;
  let selectedId: bigint | null = null;
  let confirmDelete = false;

  /** The inventory id equipped in the slot this item belongs to (off hand for shields, else main). */
  const equippedSlotId = (item: string): bigint => (equipSlotOf(item) === "offHand" ? offHandInventoryId : mainHandInventoryId);

  const setOpen = (open: boolean) => {
    const opening = open && body.hidden;
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", String(!body.hidden));
    if (!open) {
      selectedId = null;
      confirmDelete = false;
    }
    if (opening) window.dispatchEvent(new CustomEvent("hud-menu-open", { detail: "inventory" }));
  };
  const toggleOpen = () => setOpen(body.hidden === true);
  toggle.addEventListener("click", toggleOpen);
  registerKeybind({ id: "hud-inventory", matches: (event) => event.code === "KeyI", handler: toggleOpen });
  window.addEventListener("hud-menu-open", ((event: Event) => {
    if ((event as CustomEvent<string>).detail !== "inventory") setOpen(false);
  }) as EventListener);

  const equippedGroup = (label: string, item: string): HTMLDivElement => {
    const group = document.createElement("div");
    group.className = "inventory-equipped-group";
    const text = document.createElement("span");
    text.textContent = label;
    const slot = document.createElement("span");
    slot.className = "inventory-equipped-slot";
    slot.title = item ? (ITEMS[item as keyof typeof ITEMS]?.name ?? item) : "Empty";
    slot.setAttribute("aria-label", `${label}: ${slot.title}`);
    slot.appendChild(itemIcon(item || "empty"));
    group.append(text, slot);
    return group;
  };

  const render = () => {
    equipped.replaceChildren(equippedGroup("Main hand", mainHand), equippedGroup("Off hand", offHand));

    list.replaceChildren();

    const sorted = [...rows.values()].sort((a, b) => a.item.localeCompare(b.item) || Number(a.id - b.id));

    if (selectedId !== null && !rows.has(selectedId.toString())) {
      selectedId = null;
      confirmDelete = false;
    }

    for (const row of sorted) {
      const def = ITEMS[row.item as keyof typeof ITEMS];
      const name = def?.name ?? row.item;
      const item = document.createElement("button");
      item.type = "button";
      item.className = "inventory-item";
      const equippedNow = row.id === equippedSlotId(row.item);
      const selectedNow = row.id === selectedId;
      item.setAttribute("aria-label", `${name}${equippedNow ? ", equipped" : ""}`);
      item.setAttribute("aria-pressed", String(equippedNow));
      item.setAttribute("aria-haspopup", "true");
      item.setAttribute("aria-expanded", String(selectedNow));
      if (selectedNow) item.classList.add("is-selected");
      item.title = name;
      item.appendChild(itemIcon(row.item));

      if (row.qty > 1) {
        const qty = document.createElement("span");
        qty.className = "inventory-qty";
        qty.textContent = `x${row.qty}`;
        item.appendChild(qty);
      }
      item.addEventListener("click", () => {
        selectedId = selectedNow ? null : row.id;
        confirmDelete = false;
        render();
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

    renderActions();
  };

  const action = (label: string, onClick: () => void): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "inventory-action";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  };

  const run = (label: string, item: string, op: () => Promise<unknown>, analyticsAction: string) => {
    void op().catch((err) => {
      logError(`${label} request failed`, { surface: "inventory", action: analyticsAction, item, error: err });
    });
  };

  const renderActions = () => {
    actions.replaceChildren();
    const row = selectedId !== null ? rows.get(selectedId.toString()) : undefined;
    if (!row) {
      actions.hidden = true;
      return;
    }
    actions.hidden = false;
    const def = ITEMS[row.item as keyof typeof ITEMS];

    const name = document.createElement("span");
    name.className = "inventory-action-name";
    name.textContent = def?.name ?? row.item;
    actions.appendChild(name);

    const buttons = document.createElement("div");
    buttons.className = "inventory-action-buttons";

    if (confirmDelete) {
      const confirm = action("Confirm delete", () => run("Discard item", row.item, () => discardItem(conn, row.id), "discard_item"));
      confirm.classList.add("is-danger");
      const cancel = action("Cancel", () => {
        confirmDelete = false;
        render();
      });
      buttons.append(confirm, cancel);
      actions.appendChild(buttons);
      return;
    }

    if (isEquippableItem(row.item)) {
      const equippedNow = row.id === equippedSlotId(row.item);
      buttons.appendChild(
        action(equippedNow ? "Unequip" : "Equip", () => run("Equip item", row.item, () => equipItem(conn, row.id), "equip_item")),
      );
    }
    buttons.appendChild(action("Drop", () => run("Drop item", row.item, () => dropItem(conn, row.id), "drop_item")));
    buttons.appendChild(
      action("Delete", () => {
        confirmDelete = true;
        render();
      }),
    );
    actions.appendChild(buttons);
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
    offHand = p.equippedOffHand;
    offHandInventoryId = p.equippedOffHandInventoryId;
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

// Item icons render from the real 3D models (game/icons.ts) so the inventory,
// equipped slot, and spawn buttons show the exact object the world renders.
export { itemIcon } from "../game/icons.js";
