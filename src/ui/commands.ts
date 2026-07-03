import { CHEAT_SPEED_MULTIPLIER, HOG_STYLES, ITEMS, SPAWNABLE_ITEM_IDS, type HogStyle, type SpawnableItemId, type Zone } from "@trogg/shared";
import { hogIcon as hogModelIcon, hudIcon } from "../game/icons.js";
import type { DbConnection } from "../net/module_bindings";
import { logError, logInfo } from "../analytics.js";
import { audio } from "../audio.js";
import { hudRoot } from "./hud.js";
import { registerKeybind } from "./keybinds.js";
import { currentCommandFlags, type ChatCommandFlags } from "./chat_commands.js";
import { hauntGhost, resetBoulders, resetHogs, spawnDebugEntity } from "../net/procedures.js";
import { itemIcon } from "./inventory.js";

type SpawnRequest = { kind: "boulder" } | { kind: "tree" } | { kind: "hog"; style: HogStyle } | { kind: "item"; item: SpawnableItemId };

export interface CommandPanelContext {
  conn: DbConnection;
  zone: Zone;
}

/** Mount the pre-alpha Commands drawer: a right-edge slide-out holding every
 * debug tool (spawn, reset, ghost, cheats, world dials) — deliberately on the
 * opposite side from the player-facing top-left menus, so debug chrome never
 * crowds real controls. */
export function mountCommands({ conn, zone }: CommandPanelContext): void {
  const flags = currentCommandFlags();
  if (!flags.spawn && !flags.resetBoulders && !flags.resetHogs && !flags.ghost && !flags.cheats) return;

  const root = document.createElement("div");
  root.className = "commands command-drawer";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "hud-icon-button command-toggle";
  toggle.setAttribute("aria-label", "Commands");
  toggle.setAttribute("aria-keyshortcuts", "`");
  toggle.title = "Commands (`)";
  toggle.appendChild(hudIcon("commands"));

  const body = document.createElement("div");
  body.className = "command-body";

  const status = document.createElement("div");
  status.className = "command-status";
  status.textContent = "pre-alpha debug tools";

  if (flags.cheats) body.appendChild(cheatsSection(conn, zone.slug, status));
  if (flags.cheats) body.appendChild(worldSection(status));
  if (flags.spawn) body.appendChild(spawnSection(conn, zone.slug, status));
  if (flags.resetBoulders || flags.resetHogs) body.appendChild(resetSection(conn, zone.slug, flags, status));
  if (flags.ghost) body.appendChild(ghostSection(conn, zone.slug, status));
  body.appendChild(debugSection(status));
  body.appendChild(status);

  const setOpen = (open: boolean) => {
    const opening = open && !root.classList.contains("is-open");
    root.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (opening) window.dispatchEvent(new CustomEvent("hud-menu-open", { detail: "commands" }));
  };
  const toggleOpen = () => setOpen(!root.classList.contains("is-open"));
  toggle.addEventListener("click", toggleOpen);
  registerKeybind({ id: "hud-commands", matches: (event) => event.code === "Backquote", handler: toggleOpen });
  window.addEventListener("hud-menu-open", ((event: Event) => {
    if ((event as CustomEvent<string>).detail !== "commands") setOpen(false);
  }) as EventListener);

  root.append(toggle, body);
  hudRoot().appendChild(root);
}

/** Client-side world dials. The daylight slider overrides the shared wall-clock
 *  day phase for THIS client's rendering only (the cycle is cosmetic — nothing
 *  authoritative reads it), so scrubbing to noon never changes another player's
 *  sky; "live" hands the sky back to the shared clock. */
function worldSection(status: HTMLElement): HTMLElement {
  const section = commandSection("World");

  const row = document.createElement("div");
  row.className = "command-daylight";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "1000";
  slider.step = "1";
  slider.setAttribute("aria-label", "Time of day");
  const live = commandButton("Live");
  live.setAttribute("aria-pressed", "true");

  const names = ["dawn", "morning", "noon", "afternoon", "dusk", "evening", "midnight", "small hours"];
  const label = document.createElement("div");
  label.className = "command-hint";

  const apply = (phase: number | null) => {
    live.setAttribute("aria-pressed", String(phase === null));
    label.textContent = phase === null ? "live — the shared sky" : `sky locked at ${names[Math.floor(phase * 8) % 8]}`;
    window.dispatchEvent(new CustomEvent("trogg-debug-daylight", { detail: phase }));
    status.textContent = phase === null ? "sky follows the shared clock" : "sky locked (this client only)";
  };
  slider.addEventListener("input", () => apply(Number(slider.value) / 1000));
  live.addEventListener("click", () => apply(null));
  apply(null);

  row.append(slider, live);
  section.append(row, label);
  return section;
}

function spawnSection(conn: DbConnection, zone: string, status: HTMLElement): HTMLElement {
  const section = commandSection("Spawn");
  const grid = document.createElement("div");
  grid.className = "command-spawn-grid";

  grid.appendChild(spawnButton("Boulder", itemIcon("boulder"), () => requestSpawn(conn, zone, status, { kind: "boulder" })));
  grid.appendChild(spawnButton("Tree", itemIcon("tree"), () => requestSpawn(conn, zone, status, { kind: "tree" })));
  for (const style of HOG_STYLES) {
    const label = `${titleCaseWords(style)} Hog`;
    grid.appendChild(spawnButton(label, hogIcon(style), () => requestSpawn(conn, zone, status, { kind: "hog", style })));
  }
  for (const item of SPAWNABLE_ITEM_IDS) {
    grid.appendChild(spawnButton(ITEMS[item].name, itemIcon(item), () => requestSpawn(conn, zone, status, { kind: "item", item })));
  }

  section.appendChild(grid);
  return section;
}

function requestSpawn(conn: DbConnection, zone: string, status: HTMLElement, request: SpawnRequest) {
  const item = request.kind === "hog" ? request.style : request.kind === "item" ? request.item : "";
  const label = request.kind === "hog" ? `${titleCaseWords(request.style)} Hog` : request.kind === "item" ? ITEMS[request.item].name : request.kind;
  void spawnDebugEntity(conn, request.kind, item, "commands").catch((err) => {
    logError("Command spawn request failed", { surface: "commands", action: "spawn", zone, kind: request.kind, item, error: err });
    audio.playError();
    status.textContent = "couldn't request spawn";
  });
  logInfo("Debug entity spawn requested", { surface: "commands", action: "spawn", zone, kind: request.kind, item, source: "commands" });
  audio.playCommand();
  status.textContent = `requested ${label}`;
}

function resetSection(conn: DbConnection, zone: string, flags: ChatCommandFlags, status: HTMLElement): HTMLElement {
  const section = commandSection("Reset");
  const grid = document.createElement("div");
  grid.className = "command-grid";

  if (flags.resetBoulders) {
    const button = commandButton("Reset boulders");
    button.addEventListener("click", () => {
      void resetBoulders(conn, "commands").catch((err) => {
        logError("Command reset request failed", { surface: "commands", action: "reset_boulders", zone, error: err });
        audio.playError();
        status.textContent = "couldn't reset boulders";
      });
      logInfo("Command reset requested", { surface: "commands", action: "reset_boulders", zone, source: "commands" });
      audio.playCommand();
      status.textContent = "reset boulders";
    });
    grid.appendChild(button);
  }

  if (flags.resetHogs) {
    const button = commandButton("Reset Hogs");
    button.addEventListener("click", () => {
      void resetHogs(conn, "commands").catch((err) => {
        logError("Command reset request failed", { surface: "commands", action: "reset_hogs", zone, error: err });
        audio.playError();
        status.textContent = "couldn't reset Hogs";
      });
      logInfo("Command reset requested", { surface: "commands", action: "reset_hogs", zone, source: "commands" });
      audio.playCommand();
      status.textContent = "reset Hogs";
    });
    grid.appendChild(button);
  }

  if (flags.resetBoulders && flags.resetHogs) {
    const button = commandButton("Reset both");
    button.addEventListener("click", () => {
      void resetBoulders(conn, "commands").catch((err) => {
        logError("Command reset request failed", { surface: "commands", action: "reset_boulders", zone, error: err });
        audio.playError();
        status.textContent = "couldn't reset boulders";
      });
      void resetHogs(conn, "commands").catch((err) => {
        logError("Command reset request failed", { surface: "commands", action: "reset_hogs", zone, error: err });
        audio.playError();
        status.textContent = "couldn't reset Hogs";
      });
      logInfo("Command reset requested", { surface: "commands", action: "reset_both", zone, source: "commands" });
      audio.playCommand();
      status.textContent = "reset boulders and Hogs";
    });
    grid.appendChild(button);
  }

  section.appendChild(grid);
  return section;
}

function ghostSection(conn: DbConnection, zone: string, status: HTMLElement): HTMLElement {
  const section = commandSection("Ghost");
  const grid = document.createElement("div");
  grid.className = "command-grid";

  const once = commandButton("Summon ghost");
  once.addEventListener("click", () => {
    status.textContent = haunt(conn, zone, 1) ? "requested one ghost" : "couldn't request ghost";
  });

  const burst = commandButton("Ghost burst");
  burst.addEventListener("click", () => {
    status.textContent = haunt(conn, zone, 8) ? "requested eight ghosts" : "couldn't request ghosts";
  });

  grid.append(once, burst);
  section.appendChild(grid);
  return section;
}

function haunt(conn: DbConnection, zone: string, count: number): boolean {
  void hauntGhost(conn, count, "commands").catch((err) => {
    logError("Command ghost request failed", { surface: "commands", action: "haunt_ghost", zone, count, error: err });
    audio.playError();
  });
  logInfo("Command ghost requested", { surface: "commands", action: "haunt_ghost", zone, count, source: "commands" });
  audio.playCommand();
  return true;
}

/** Debug cheats (GDD "Commands panel"): speed, flight, invulnerability. Each
 *  button toggles one field and sends the full triple to `setCheats`; pressed
 *  state paints from the live player row, so it survives reloads and stays
 *  honest if the server clamps a value. */
function cheatsSection(conn: DbConnection, zone: string, status: HTMLElement): HTMLElement {
  const section = commandSection("Cheats");
  const grid = document.createElement("div");
  grid.className = "command-grid";

  const me = () => (conn.identity ? conn.db.player.identity.find(conn.identity) : undefined);
  const current = () => {
    const p = me();
    return { speed: (p?.cheatSpeed ?? 1) > 1, fly: p?.cheatFly ?? false, noclip: p?.cheatNoclip ?? false, invulnerable: p?.cheatInvulnerable ?? false };
  };

  const buttons = {
    speed: commandButton(`Speed ×${CHEAT_SPEED_MULTIPLIER}`),
    fly: commandButton("Fly"),
    noclip: commandButton("Noclip"),
    invulnerable: commandButton("God mode"),
  };
  const KEYS = ["speed", "fly", "noclip", "invulnerable"] as const;
  const paint = () => {
    const state = current();
    for (const key of KEYS) buttons[key].setAttribute("aria-pressed", String(state[key]));
  };
  const label = { speed: "speed", fly: "fly", noclip: "noclip", invulnerable: "god mode" } as const;
  for (const key of KEYS) {
    buttons[key].addEventListener("click", () => {
      const next = { ...current(), [key]: !current()[key] };
      void conn.reducers
        .setCheats({ speed: next.speed ? CHEAT_SPEED_MULTIPLIER : 1, fly: next.fly, noclip: next.noclip, invulnerable: next.invulnerable })
        .catch((err: unknown) => {
          logError("Cheat toggle failed", { surface: "commands", action: "set_cheats", zone, cheat: key, error: err });
          audio.playError();
          status.textContent = "couldn't toggle cheat";
        });
      logInfo("Cheat toggled", { surface: "commands", action: "set_cheats", zone, cheat: key, on: next[key], source: "commands" });
      audio.playCommand();
      status.textContent = `${label[key]} ${next[key] ? "on" : "off"}`;
    });
    grid.appendChild(buttons[key]);
  }
  conn.db.player.onUpdate((_ctx, _old, row) => {
    if (conn.identity && row.identity.isEqual(conn.identity)) paint();
  });
  conn.db.player.onInsert((_ctx, row) => {
    if (conn.identity && row.identity.isEqual(conn.identity)) paint();
  });
  paint();

  section.appendChild(grid);
  const hint = document.createElement("div");
  hint.className = "command-hint";
  hint.textContent = "fly clears the world: Space climbs, C sinks · noclip walks through anything while grounded";
  section.appendChild(hint);
  return section;
}

/** Client-side debug overlays: combat hit circles plus the local melee reach cone. */
function debugSection(status: HTMLElement): HTMLElement {
  const section = commandSection("Debug");
  const grid = document.createElement("div");
  grid.className = "command-grid";

  const button = commandButton("Hitboxes (B)");
  button.setAttribute("aria-pressed", "false");
  let on = false;
  const toggle = () => {
    on = !on;
    button.setAttribute("aria-pressed", String(on));
    window.dispatchEvent(new CustomEvent("trogg-debug-hitboxes", { detail: on }));
    status.textContent = on ? "hitboxes shown" : "hitboxes hidden";
  };
  button.addEventListener("click", toggle);
  registerKeybind({ id: "debug-hitboxes", matches: (event) => event.code === "KeyB", handler: toggle });

  grid.appendChild(button);
  section.appendChild(grid);
  return section;
}

function commandSection(title: string): HTMLElement {
  const section = document.createElement("div");
  section.className = "command-section";
  const heading = document.createElement("div");
  heading.className = "help-section-title";
  heading.textContent = title;
  section.appendChild(heading);
  return section;
}

function commandButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "command-button";
  button.textContent = label;
  return button;
}

function spawnButton(label: string, icon: HTMLElement | SVGSVGElement, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "command-spawn-button";
  button.setAttribute("aria-label", `Spawn ${label}`);
  button.title = `Spawn ${label}`;
  button.appendChild(icon);
  button.addEventListener("click", onClick);
  return button;
}

function hogIcon(style: HogStyle): HTMLElement {
  const icon = hogModelIcon(style);
  icon.classList.add("command-avatar-icon");
  return icon;
}

function titleCaseWords(value: string): string {
  return value
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
