import { equipSlotOf, INVENTORY_SLOT_COUNT, ITEMS, isEquippableItem } from "@trogg/shared";
import { hudIcon, itemIcon } from "../game/icons.js";
import { audio } from "../audio.js";
import { logError } from "../analytics.js";
import type { DbConnection } from "../net/module_bindings";
import type { Inventory, Player } from "../net/module_bindings/types";
import { discardItem, dropItem, equipItem } from "../net/procedures.js";
import { hudLeft, hudRoot } from "./hud.js";
import { registerKeybind } from "./keybinds.js";
import { pickupToast } from "./toasts.js";
import { attachTip, hideTip } from "./tooltip.js";
import { coachHit } from "./coach.js";

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
  attachTip(toggle, "Inventory (I)", "Your pack and equipped hands", "below");
  toggle.appendChild(hudIcon("inventory"));

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

  // The right-click menu: a tile's actions (equip/drop/delete) open at the
  // cursor instead of a persistent selection row — left-clicking a tile does
  // nothing. One menu, shared by every tile, floating in the HUD root (the
  // panel's stacking context would clip it) and clamped to the viewport.
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.hidden = true;
  hudRoot().appendChild(menu);

  const closeMenu = () => {
    menu.hidden = true;
  };
  window.addEventListener("pointerdown", (event) => {
    if (!menu.contains(event.target as Node)) closeMenu();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });

  const menuButton = (label: string, onPick: (button: HTMLButtonElement) => void): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ctx-menu-item";
    button.textContent = label;
    button.addEventListener("click", () => onPick(button));
    menu.appendChild(button);
    return button;
  };

  const openMenuFor = (row: Inventory, x: number, y: number) => {
    hideTip();
    menu.replaceChildren();
    const name = document.createElement("span");
    name.className = "ctx-menu-name";
    name.textContent = ITEMS[row.item as keyof typeof ITEMS]?.name ?? row.item;
    menu.appendChild(name);

    if (isEquippableItem(row.item)) {
      const equippedNow = row.id === equippedSlotId(row.item);
      menuButton(equippedNow ? "Unequip" : "Equip", () => {
        run("Equip item", row.item, () => equipItem(conn, row.id), "equip_item");
        closeMenu();
      });
    }
    menuButton("Drop", () => {
      run("Drop item", row.item, () => dropItem(conn, row.id), "drop_item");
      closeMenu();
    });
    // delete arms itself in place: the first click turns the entry into the
    // confirm, the second destroys one unit
    menuButton("Delete", (button) => {
      if (button.classList.contains("is-danger")) {
        run("Discard item", row.item, () => discardItem(conn, row.id), "discard_item");
        closeMenu();
        return;
      }
      button.classList.add("is-danger");
      button.textContent = "Confirm delete";
    });

    // measure, then clamp fully on-screen (like the tooltip)
    menu.style.visibility = "hidden";
    menu.hidden = false;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.round(Math.max(8, Math.min(x, window.innerWidth - w - 8)))}px`;
    menu.style.top = `${Math.round(Math.max(8, Math.min(y, window.innerHeight - h - 8)))}px`;
    menu.style.visibility = "";
  };

  const rows = new Map<string, Inventory>();
  let mainHand = "";
  let mainHandInventoryId = 0n;
  let offHand = "";
  let offHandInventoryId = 0n;

  /** The inventory id equipped in the slot this item belongs to (off hand for shields, else main). */
  const equippedSlotId = (item: string): bigint => (equipSlotOf(item) === "offHand" ? offHandInventoryId : mainHandInventoryId);

  const setOpen = (open: boolean) => {
    const opening = open && body.hidden;
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", String(!body.hidden));
    if (!open) closeMenu();
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
    const def = item ? ITEMS[item as keyof typeof ITEMS] : undefined;
    const itemName = item ? (def?.name ?? item) : "Empty";
    slot.setAttribute("aria-label", `${label}: ${itemName}`);
    if (item) attachTip(slot, itemName, def?.blurb ?? "");
    else slot.title = "Empty";
    slot.appendChild(itemIcon(item || "empty"));
    group.append(text, slot);
    return group;
  };

  const render = () => {
    hideTip(); // the hovered tile may not survive the rebuild
    closeMenu(); // nor may the menu's row
    equipped.replaceChildren(equippedGroup("Main hand", mainHand), equippedGroup("Off hand", offHand));

    list.replaceChildren();

    const sorted = [...rows.values()].sort((a, b) => a.item.localeCompare(b.item) || Number(a.id - b.id));

    for (const row of sorted) {
      const def = ITEMS[row.item as keyof typeof ITEMS];
      const name = def?.name ?? row.item;
      const item = document.createElement("button");
      item.type = "button";
      item.className = "inventory-item";
      const equippedNow = row.id === equippedSlotId(row.item);
      item.setAttribute("aria-label", `${name}${equippedNow ? ", equipped" : ""}`);
      item.setAttribute("aria-pressed", String(equippedNow));
      item.setAttribute("aria-haspopup", "menu");
      attachTip(item, name, def?.blurb ?? "");
      item.appendChild(itemIcon(row.item));

      if (row.qty > 1) {
        const qty = document.createElement("span");
        qty.className = "inventory-qty";
        qty.textContent = `x${row.qty}`;
        item.appendChild(qty);
      }
      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openMenuFor(row, event.clientX, event.clientY);
      });
      // Double-click equips (or unequips) without the menu detour.
      if (isEquippableItem(row.item)) {
        item.addEventListener("dblclick", () => run("Equip item", row.item, () => equipItem(conn, row.id), "equip_item"));
      }

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

  const run = (label: string, item: string, op: () => Promise<unknown>, analyticsAction: string) => {
    void op().catch((err) => {
      logError(`${label} request failed`, { surface: "inventory", action: analyticsAction, item, error: err });
    });
  };

  const mine = (row: Inventory) => row.playerId.toHexString() === playerId;
  // Toast (and sound) live pickups only: rows the initial subscription
  // delivers are what the trogg already held, not something just picked up.
  const announcePickup = (item: string, qty: number) => {
    pickupToast(item, qty);
    audio.playPickup(item);
    coachHit("first-pickup");
  };
  conn.db.inventory.onInsert((ctx, row) => {
    if (!mine(row)) return;
    rows.set(row.id.toString(), row);
    render();
    if (ctx.event.tag !== "SubscribeApplied") announcePickup(row.item, row.qty);
  });
  conn.db.inventory.onUpdate((ctx, old, row) => {
    if (!mine(row)) return;
    rows.set(row.id.toString(), row);
    // wear ticks (a burning torch) change nothing the panel shows — skip the
    // DOM rebuild instead of re-rendering once per burn quantum
    if (old.item === row.item && old.qty === row.qty) return;
    render();
    if (ctx.event.tag !== "SubscribeApplied" && row.qty > old.qty) announcePickup(row.item, row.qty - old.qty);
  });
  conn.db.inventory.onDelete((_ctx, row) => {
    if (!mine(row)) return;
    rows.delete(row.id.toString());
    render();
  });

  const applyPlayer = (p: Player) => {
    if (p.identity.toHexString() !== playerId) return;
    // first time either hand goes from empty to holding something
    if (!mainHand && !offHand && (p.equippedMainHand || p.equippedOffHand)) coachHit("first-equip");
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

// Item icons render from the real 3D models (game/icons.ts) so the inventory,
// equipped slot, and spawn buttons show the exact object the world renders.
export { itemIcon } from "../game/icons.js";
