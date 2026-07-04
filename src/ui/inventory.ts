import { equipSlotOf, INVENTORY_SLOT_COUNT, ITEMS, isEquippableItem } from "@trogg/shared";
import { hudIcon, itemIcon } from "../game/icons.js";
import { logError } from "../analytics.js";
import type { DbConnection } from "../net/module_bindings";
import type { Inventory, Player } from "../net/module_bindings/types";
import { discardItem, dropItem, equipItem } from "../net/procedures.js";
import { hudLeft, hudRoot } from "./hud.js";
import { registerKeybind } from "./keybinds.js";
import { pickupToast } from "./toasts.js";

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
  toggle.appendChild(hudIcon("inventory"));

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

  // The one floating tooltip (name + blurb) every tile shares. It can't live
  // inside the tiles — their facet clip-path would crop it — so it floats in
  // the HUD root, placed beside whichever tile is hovered or focused.
  document.getElementById("item-tip")?.remove();
  const tip = document.createElement("div");
  tip.id = "item-tip";
  tip.className = "item-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  const tipName = document.createElement("span");
  tipName.className = "item-tip-name";
  const tipBlurb = document.createElement("span");
  tipBlurb.className = "item-tip-blurb";
  tip.append(tipName, tipBlurb);
  hudRoot().appendChild(tip);

  const attachTip = (el: HTMLElement, name: string, blurb: string) => {
    el.removeAttribute("title"); // the rich tooltip replaces the native one
    el.setAttribute("aria-describedby", "item-tip");
    const show = () => {
      tipName.textContent = name;
      tipBlurb.textContent = blurb;
      tipBlurb.hidden = blurb === "";
      const rect = el.getBoundingClientRect();
      tip.style.left = `${Math.round(rect.right + 10)}px`;
      tip.style.top = `${Math.round(rect.top + rect.height / 2)}px`;
      tip.hidden = false;
    };
    const hide = () => {
      tip.hidden = true;
    };
    el.addEventListener("mouseenter", show);
    el.addEventListener("mouseleave", hide);
    el.addEventListener("focus", show);
    el.addEventListener("blur", hide);
  };

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
    tip.hidden = true; // the hovered tile may not survive the rebuild
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
      attachTip(item, name, def?.blurb ?? "");
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
  // Toast live pickups only: rows the initial subscription delivers are what
  // the trogg already held, not something just picked up.
  conn.db.inventory.onInsert((ctx, row) => {
    if (!mine(row)) return;
    rows.set(row.id.toString(), row);
    render();
    if (ctx.event.tag !== "SubscribeApplied") pickupToast(row.item, row.qty);
  });
  conn.db.inventory.onUpdate((ctx, old, row) => {
    if (!mine(row)) return;
    rows.set(row.id.toString(), row);
    render();
    if (ctx.event.tag !== "SubscribeApplied" && row.qty > old.qty) pickupToast(row.item, row.qty - old.qty);
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

// Item icons render from the real 3D models (game/icons.ts) so the inventory,
// equipped slot, and spawn buttons show the exact object the world renders.
export { itemIcon } from "../game/icons.js";
