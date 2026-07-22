import { atFirstFire, BRAZIER_UPKEEP_ITEM, ITEMS, levelForXp, RECIPES, upkeepReserve, type Recipe } from "@trogg/shared";
import type { DbConnection } from "../net/module_bindings";
import { itemIcon } from "../game/icons.js";
import { hudLeft } from "./hud.js";
import { attachTip } from "./tooltip.js";
import { coachHit } from "./coach.js";
import { registerKeybind } from "./keybinds.js";
import { craftItem } from "../net/procedures.js";

/**
 * The crafting panel (GDD "Crafting"): the Hearth station's UI. Recipes draw
 * from the tribe's shared stockpile — never a personal stack — so the panel
 * shows the pool, each recipe's cost, and the upkeep reserve line right at
 * the moment of spending: "keep enough for everyone" is a norm with data
 * behind it. The server owns every validation (level, stock, reserve, and
 * standing inside the First Fire's ring); the panel just disables what it
 * can already see won't fly.
 */
export function mountCrafting(conn: DbConnection, playerId: string, selfPosition: () => { x: number; y: number } | undefined): void {
  document.getElementById("crafting-panel")?.remove();

  const root = document.createElement("div");
  root.id = "crafting-panel";
  root.className = "inventory crafting";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "hud-icon-button crafting-toggle";
  toggle.setAttribute("aria-label", "Crafting");
  toggle.setAttribute("aria-keyshortcuts", "C");
  attachTip(toggle, "Crafting (C)", "Craft gear from the tribe's stockpile, beside the First Fire", "below");
  toggle.appendChild(itemIcon("fine_pickaxe"));

  const body = document.createElement("div");
  body.className = "inventory-body crafting-body";
  body.hidden = true;

  const pool = document.createElement("div");
  pool.className = "crafting-pool";
  const station = document.createElement("div");
  station.className = "crafting-station";
  const list = document.createElement("div");
  list.className = "crafting-list";
  body.append(pool, station, list);
  root.append(toggle, body);
  hudLeft().appendChild(root);

  const stock = (item: string): number => {
    for (const row of conn.db.stockpile.iter()) if (row.item === item) return row.qty;
    return 0;
  };
  const reserveNow = (): number => {
    let lit = 0;
    for (const b of conn.db.brazier.iter()) if (b.lit && !b.isEternal) lit++;
    return upkeepReserve(lit);
  };
  const myLevel = (skill: string): number => {
    let xp = 0;
    for (const r of conn.db.skills.iter()) if (r.skill === skill && r.playerId.toHexString() === playerId) xp += r.xp;
    return levelForXp(xp);
  };

  const costText = (r: Recipe): string =>
    Object.entries(r.costs)
      .map(([item, qty]) => `${qty} ${ITEMS[item as keyof typeof ITEMS]?.name.toLowerCase() ?? item}`)
      .join(" · ");

  const atStationNow = () => atFirstFire(selfPosition(), conn.db.brazier.iter());
  let wasAtStation: boolean | undefined;
  const render = () => {
    const reserve = reserveNow();
    const atStation = atStationNow();
    wasAtStation = atStation;
    pool.textContent = `Stockpile: ${stock("stone")} stone · ${stock("wood")} wood — ${reserve} ${BRAZIER_UPKEEP_ITEM} held back for the fires`;
    station.textContent = atStation ? "Crafting at the First Fire" : "Craft beside the First Fire — return to its light";
    station.classList.toggle("is-blocked", !atStation);

    list.replaceChildren();
    for (const recipe of RECIPES) {
      const def = ITEMS[recipe.output];
      const row = document.createElement("div");
      row.className = "crafting-row";

      row.appendChild(itemIcon(recipe.output));
      const name = document.createElement("span");
      name.className = "crafting-name";
      name.textContent = def.name;
      attachTip(name, def.name, def.blurb);
      const cost = document.createElement("span");
      cost.className = "crafting-cost";
      cost.textContent = costText(recipe);

      const levelOk = myLevel(recipe.skill) >= recipe.level;
      const stoneOk = stock("stone") >= (recipe.costs.stone ?? 0);
      const woodOk = stock("wood") - (recipe.costs.wood ?? 0) >= reserve && stock("wood") >= (recipe.costs.wood ?? 0);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "crafting-craft";
      button.textContent = levelOk ? "Craft" : `${recipe.skill} ${recipe.level}`;
      button.disabled = !atStation || !levelOk || !stoneOk || !woodOk;
      attachTip(
        button,
        !atStation ? "Return to the First Fire" : levelOk ? `Craft ${def.name}` : `Needs ${recipe.skill} level ${recipe.level}`,
        !atStation ? "Crafting only works within its light" : !stoneOk || !woodOk ? "The stockpile can't cover it right now — the fire eats first" : "Drawn from the tribe's stockpile, beside the First Fire",
      );
      button.addEventListener("click", () => void craftItem(conn, recipe.output, "crafting-panel"));

      row.append(name, cost, button);
      list.appendChild(row);
    }
  };

  let stationRefresh: number | undefined;
  const setOpen = (opening: boolean) => {
    body.hidden = !opening;
    if (stationRefresh !== undefined) window.clearInterval(stationRefresh);
    stationRefresh = opening
      ? window.setInterval(() => {
          if (atStationNow() !== wasAtStation) render();
        }, 250)
      : undefined;
    if (opening) {
      render();
      coachHit("first-craft");
      window.dispatchEvent(new CustomEvent("hud-menu-open", { detail: "crafting" }));
    }
  };
  const toggleOpen = () => setOpen(body.hidden === true);
  toggle.addEventListener("click", toggleOpen);
  registerKeybind({ id: "hud-crafting", matches: (event) => event.code === "KeyC", handler: toggleOpen });
  window.addEventListener("hud-menu-open", ((event: Event) => {
    if ((event as CustomEvent<string>).detail !== "crafting") setOpen(false);
  }) as EventListener);

  const rerender = () => {
    if (!body.hidden) render();
  };
  conn.db.stockpile.onInsert(rerender);
  conn.db.stockpile.onUpdate(rerender);
  conn.db.skills.onInsert(rerender);
  conn.db.skills.onUpdate(rerender);
  conn.db.brazier.onInsert(rerender);
  conn.db.brazier.onUpdate(rerender);
}
