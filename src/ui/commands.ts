import { CHEAT_SPEED_MULTIPLIER, DARK_CREATURE_SPECIES, DARK_CREATURES, ITEMS, SPAWNABLE_ITEM_IDS, type DarkCreatureSpecies, type SpawnableItemId, type Zone } from "@trogg/shared";
import { darkCreatureIcon, hudIcon } from "../game/icons.js";
import type { DbConnection } from "../net/module_bindings";
import { logError, logInfo } from "../analytics.js";
import { audio } from "../audio.js";
import { hudRoot } from "./hud.js";
import { registerKeybind } from "./keybinds.js";
import { currentCommandFlags, type ChatCommandFlags } from "./chat_commands.js";
import { hauntGhost, resetBoulders, resetDarkCreatures, spawnDebugEntity } from "../net/procedures.js";
import { itemIcon } from "./inventory.js";
import { attachTip } from "./tooltip.js";

type SpawnRequest = { kind: "boulder" } | { kind: "tree" } | { kind: "item"; item: SpawnableItemId } | { kind: "dark_creature"; species: DarkCreatureSpecies };

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
  if (!flags.spawn && !flags.resetBoulders && !flags.resetDarkCreatures && !flags.ghost && !flags.cheats) return;

  const root = document.createElement("div");
  root.className = "commands command-drawer";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "hud-icon-button command-toggle";
  toggle.setAttribute("aria-label", "Debug Tools");
  toggle.setAttribute("aria-keyshortcuts", "`");
  attachTip(toggle, "Debug Tools (`)", "", "left");
  toggle.appendChild(hudIcon("commands"));

  const body = document.createElement("div");
  body.className = "command-body";

  const status = document.createElement("div");
  status.className = "command-status";
  status.textContent = "pre-alpha debug tools";

  if (flags.cheats) {
    const toggle = cheatToggles(conn, zone.slug, status);
    body.append(movementSection(toggle), survivalSection(conn, zone.slug, status, toggle), worldSection(conn, zone.slug, status));
  }
  if (flags.spawn) body.appendChild(spawnSection(conn, zone.slug, status));
  if (flags.resetBoulders || flags.resetDarkCreatures) body.appendChild(resetSection(conn, zone.slug, flags, status));
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

/** Shared world dials. The daylight slider pins the day-night phase for EVERY
 *  client via the `world_state` singleton (the sky is shared fiction); "Live"
 *  hands the sky back to the shared wall clock. The controls paint from the
 *  synced row, so every open drawer shows the same sky state. */
function worldSection(conn: DbConnection, zone: string, status: HTMLElement): HTMLElement {
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
  label.textContent = "live — the shared sky";

  const paint = (state: { skyLocked: boolean; skyPhase: number }) => {
    live.setAttribute("aria-pressed", String(!state.skyLocked));
    if (state.skyLocked) slider.value = String(Math.round(state.skyPhase * 1000));
    label.textContent = state.skyLocked ? `sky locked at ${names[Math.floor(state.skyPhase * 8) % 8]} — for everyone` : "live — the shared sky";
  };
  conn.db.worldState.onInsert((_ctx, state) => paint(state));
  conn.db.worldState.onUpdate((_ctx, _old, state) => paint(state));

  const send = (phase: number, locked: boolean) => {
    void conn.reducers.setSky({ phase, locked }).catch((err: unknown) => {
      logError("Sky change failed", { surface: "commands", action: "set_sky", zone, error: err });
      audio.playError();
      status.textContent = "couldn't change the sky";
    });
    logInfo("Sky changed", { surface: "commands", action: "set_sky", zone, locked, source: "commands" });
    audio.playCommand();
    status.textContent = locked ? "sky locked — for everyone" : "sky follows the shared clock";
  };
  slider.addEventListener("input", () => send(Number(slider.value) / 1000, true));
  live.addEventListener("click", () => send(0, false));

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
  for (const item of SPAWNABLE_ITEM_IDS) {
    grid.appendChild(spawnButton(ITEMS[item].name, itemIcon(item), () => requestSpawn(conn, zone, status, { kind: "item", item })));
  }
  for (const species of DARK_CREATURE_SPECIES) {
    grid.appendChild(spawnButton(DARK_CREATURES[species].name, darkCreatureIcon(species), () => requestSpawn(conn, zone, status, { kind: "dark_creature", species })));
  }

  section.appendChild(grid);
  return section;
}

function requestSpawn(conn: DbConnection, zone: string, status: HTMLElement, request: SpawnRequest) {
  const item = request.kind === "item" ? request.item : request.kind === "dark_creature" ? request.species : "";
  const label = request.kind === "item" ? ITEMS[request.item].name : request.kind === "dark_creature" ? DARK_CREATURES[request.species].name : request.kind;
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

  if (flags.resetDarkCreatures) {
    const button = commandButton("Reset dark creatures");
    button.addEventListener("click", () => {
      void resetDarkCreatures(conn, "commands").catch((err) => {
        logError("Command reset request failed", { surface: "commands", action: "reset_dark_creatures", zone, error: err });
        audio.playError();
        status.textContent = "couldn't reset dark creatures";
      });
      logInfo("Command reset requested", { surface: "commands", action: "reset_dark_creatures", zone, source: "commands" });
      audio.playCommand();
      status.textContent = "reset dark creatures";
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

/** The cheat toggles' shared controller: each button flips one field and sends
 *  the full state to `setCheats`; pressed state paints from the live player
 *  row, so it survives reloads and stays honest if the server clamps a value. */
function cheatToggles(conn: DbConnection, zone: string, status: HTMLElement) {
  const me = () => (conn.identity ? conn.db.player.identity.find(conn.identity) : undefined);
  const current = () => {
    const p = me();
    return { speed: (p?.cheatSpeed ?? 1) > 1, fly: p?.cheatFly ?? false, noclip: p?.cheatNoclip ?? false, invulnerable: p?.cheatInvulnerable ?? false };
  };
  type CheatKey = keyof ReturnType<typeof current>;
  const painters: (() => void)[] = [];
  const paint = () => painters.forEach((fn) => fn());
  conn.db.player.onUpdate((_ctx, _old, row) => {
    if (conn.identity && row.identity.isEqual(conn.identity)) paint();
  });
  conn.db.player.onInsert((_ctx, row) => {
    if (conn.identity && row.identity.isEqual(conn.identity)) paint();
  });
  return (key: CheatKey, text: string, label: string): HTMLButtonElement => {
    const button = commandButton(text);
    painters.push(() => button.setAttribute("aria-pressed", String(current()[key])));
    button.addEventListener("click", () => {
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
      status.textContent = `${label} ${next[key] ? "on" : "off"}`;
    });
    button.setAttribute("aria-pressed", "false");
    return button;
  };
}

/** Movement cheats (GDD "Debug cheats"): speed, flight, noclip. */
function movementSection(toggle: ReturnType<typeof cheatToggles>): HTMLElement {
  const section = commandSection("Movement");
  const grid = document.createElement("div");
  grid.className = "command-grid";
  grid.append(toggle("speed", `Speed ×${CHEAT_SPEED_MULTIPLIER}`, "speed"), toggle("fly", "Fly", "fly"), toggle("noclip", "Noclip", "noclip"));
  section.appendChild(grid);
  const hint = document.createElement("div");
  hint.className = "command-hint";
  hint.textContent = "fly: Space climbs, C sinks — you pass whatever sits below you · noclip walks through anything";
  section.appendChild(hint);
  return section;
}

/** Survival tools (GDD "Debug cheats"): god mode, plus the alpha-tester escape
 *  hatches — full heal, and Unstuck for any weird spot you lock yourself into. */
function survivalSection(conn: DbConnection, zone: string, status: HTMLElement, toggle: ReturnType<typeof cheatToggles>): HTMLElement {
  const section = commandSection("Survival");
  const grid = document.createElement("div");
  grid.className = "command-grid";

  const heal = commandButton("Heal");
  heal.addEventListener("click", () => {
    void conn.reducers.healSelf({}).catch((err: unknown) => {
      logError("Heal failed", { surface: "commands", action: "heal_self", zone, error: err });
      audio.playError();
      status.textContent = "couldn't heal";
    });
    logInfo("Heal requested", { surface: "commands", action: "heal_self", zone, source: "commands" });
    audio.playCommand();
    status.textContent = "healed to full";
  });

  const unstuck = commandButton("Unstuck");
  unstuck.addEventListener("click", () => {
    void conn.reducers.rescue({}).catch((err: unknown) => {
      logError("Rescue failed", { surface: "commands", action: "rescue", zone, error: err });
      audio.playError();
      status.textContent = "couldn't rescue";
    });
    logInfo("Rescue requested", { surface: "commands", action: "rescue", zone, source: "commands" });
    audio.playCommand();
    status.textContent = "moved to safe ground";
  });

  grid.append(toggle("invulnerable", "God mode", "god mode"), heal, unstuck);
  section.appendChild(grid);
  const hint = document.createElement("div");
  hint.className = "command-hint";
  hint.textContent = "Unstuck lands you on the nearest safe tile (spawn as a last resort)";
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
  // the tooltip skips the verb — the tile sits under the "Spawn" heading
  attachTip(button, label, "", "left");
  button.appendChild(icon);
  button.addEventListener("click", onClick);
  return button;
}

