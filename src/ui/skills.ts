import { AFK_UNLOCK_XP, LEVEL_CAP, levelForXp, SKILL_IDS, xpForLevel } from "@trogg/shared";
import type { DbConnection } from "../net/module_bindings";
import { itemIcon } from "../game/icons.js";
import { hudLeft } from "./hud.js";
import { attachTip } from "./tooltip.js";
import { registerKeybind } from "./keybinds.js";

/**
 * The skills panel (GDD "Skills and XP"): the trogg's own progression at a
 * glance — each skill's level and progress to the next, the overall level
 * (total XP through the same curve, derived like everything else), and how
 * far the AFK eligibility gate is (GDD "Presence"). Personal-progress stats
 * are fine to show; only world-size facts stay hidden (Generation).
 */
export function mountSkills(conn: DbConnection, playerId: string): void {
  document.getElementById("skills-panel")?.remove();

  const root = document.createElement("div");
  root.id = "skills-panel";
  root.className = "inventory skills";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "hud-icon-button skills-toggle";
  toggle.setAttribute("aria-label", "Skills");
  toggle.setAttribute("aria-keyshortcuts", "K");
  attachTip(toggle, "Skills (K)", "Your levels and XP", "below");
  toggle.appendChild(itemIcon("quill"));

  const body = document.createElement("div");
  body.className = "inventory-body skills-body";
  body.hidden = true;
  root.append(toggle, body);
  hudLeft().appendChild(root);

  const myXp = (skill?: string): number => {
    let sum = 0;
    for (const r of conn.db.skills.iter()) {
      if (r.playerId.toHexString() !== playerId) continue;
      if (skill === undefined || r.skill === skill) sum += r.xp;
    }
    return sum;
  };

  const bar = (fraction: number): HTMLDivElement => {
    const track = document.createElement("div");
    track.className = "skills-bar";
    const fill = document.createElement("div");
    fill.className = "skills-bar-fill";
    fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    track.appendChild(fill);
    return track;
  };

  const render = () => {
    body.replaceChildren();

    const total = myXp();
    const overall = levelForXp(total);
    const header = document.createElement("div");
    header.className = "skills-overall";
    header.textContent = `Overall level ${overall}`;
    attachTip(header, `Overall level ${overall}`, `${total} XP across every skill — one curve, whatever the mix`);
    body.appendChild(header);

    // The AFK gate is the first thing a new trogg is working toward.
    const afk = document.createElement("div");
    afk.className = "skills-afk";
    if (total >= AFK_UNLOCK_XP) {
      afk.textContent = "Keeps gathering while you're away ✓";
      attachTip(afk, "AFK gathering unlocked", "Log off on safe ground and your trogg works on");
    } else {
      afk.textContent = `${AFK_UNLOCK_XP - total} XP until your trogg gathers while you're away`;
      attachTip(afk, "AFK gathering locked", "Earn XP by mining, felling, and fighting — real play unlocks it");
      body.appendChild(bar(total / AFK_UNLOCK_XP));
    }
    body.appendChild(afk);

    for (const skill of SKILL_IDS) {
      const xp = myXp(skill);
      const level = levelForXp(xp);
      const row = document.createElement("div");
      row.className = "skills-row";
      const name = document.createElement("span");
      name.className = "skills-name";
      name.textContent = skill;
      const lvl = document.createElement("span");
      lvl.className = "skills-level";
      lvl.textContent = `Lv ${level}`;
      row.append(name, lvl);
      body.appendChild(row);
      if (level < LEVEL_CAP) {
        const into = xp - xpForLevel(level);
        const span = xpForLevel(level + 1) - xpForLevel(level);
        attachTip(row, `${skill} — level ${level}`, `${into} / ${span} XP toward level ${level + 1}`);
        body.appendChild(bar(into / span));
      } else {
        attachTip(row, `${skill} — level ${level}`, "At the cap");
      }
    }
  };

  const setOpen = (opening: boolean) => {
    body.hidden = !opening;
    if (opening) {
      render();
      window.dispatchEvent(new CustomEvent("hud-menu-open", { detail: "skills" }));
    }
  };
  const toggleOpen = () => setOpen(body.hidden === true);
  toggle.addEventListener("click", toggleOpen);
  registerKeybind({ id: "hud-skills", matches: (event) => event.code === "KeyK", handler: toggleOpen });
  window.addEventListener("hud-menu-open", ((event: Event) => {
    if ((event as CustomEvent<string>).detail !== "skills") setOpen(false);
  }) as EventListener);

  const rerender = () => {
    if (!body.hidden) render();
  };
  conn.db.skills.onInsert(rerender);
  conn.db.skills.onUpdate(rerender);
}
