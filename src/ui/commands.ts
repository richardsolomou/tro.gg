import avatarUrl from "../../assets/sprites/troggs-and-hogs.png";
import { FRAME_H, FRAME_W, frameRect, HOG_STYLES, ITEMS, SHEET_H, SHEET_W, SPAWNABLE_ITEM_IDS, type HogStyle, type SpawnableItemId, type Zone } from "@trogg/shared";
import type { DbConnection } from "../net/module_bindings";
import { logError, logInfo } from "../analytics.js";
import { audio } from "../audio.js";
import { hudLeft } from "./hud.js";
import { registerKeybind } from "./keybinds.js";
import { currentCommandFlags, type ChatCommandFlags } from "./chat_commands.js";
import { hauntGhost, resetBoulders, resetHogs, spawnDebugEntity } from "../net/procedures.js";
import { itemIcon } from "./inventory.js";

type SpawnRequest = { kind: "boulder" } | { kind: "hog"; style: HogStyle } | { kind: "item"; item: SpawnableItemId };

export interface CommandPanelContext {
  conn: DbConnection;
  zone: Zone;
}

/** Mount the pre-alpha Commands panel beside Help. It exposes bounded debug
 * controls for stress testing without using chat slash commands. */
export function mountCommands({ conn, zone }: CommandPanelContext): void {
  const flags = currentCommandFlags();
  if (!flags.spawn && !flags.resetBoulders && !flags.resetHogs && !flags.ghost) return;

  const root = document.createElement("div");
  root.className = "commands";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "hud-icon-button command-toggle";
  toggle.setAttribute("aria-label", "Commands");
  toggle.setAttribute("aria-keyshortcuts", "`");
  toggle.title = "Commands (`)";
  toggle.appendChild(commandIcon());

  const body = document.createElement("div");
  body.className = "command-body";
  body.hidden = true;

  const status = document.createElement("div");
  status.className = "command-status";

  if (flags.spawn) body.appendChild(spawnSection(conn, zone.slug, status));
  if (flags.resetBoulders || flags.resetHogs) body.appendChild(resetSection(conn, zone.slug, flags, status));
  if (flags.ghost) body.appendChild(ghostSection(conn, zone.slug, status));
  body.appendChild(status);

  const setOpen = (open: boolean) => {
    const opening = open && body.hidden;
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", String(!body.hidden));
    if (opening) window.dispatchEvent(new CustomEvent("hud-menu-open", { detail: "commands" }));
  };
  const toggleOpen = () => setOpen(body.hidden === true);
  toggle.addEventListener("click", toggleOpen);
  registerKeybind({ id: "hud-commands", matches: (event) => event.code === "Backquote", handler: toggleOpen });
  window.addEventListener("hud-menu-open", ((event: Event) => {
    if ((event as CustomEvent<string>).detail !== "commands") setOpen(false);
  }) as EventListener);

  root.append(toggle, body);
  hudLeft().appendChild(root);
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

function commandIcon(): SVGSVGElement {
  const icon = svg(24, 24);
  icon.append(
    el("rect", { x: 4, y: 5, width: 16, height: 14, rx: 2, fill: "none", stroke: "currentColor", "stroke-width": 2 }),
    el("path", { d: "M8 10l3 2-3 2", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }),
    el("path", { d: "M13 15h4", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" }),
  );
  return icon;
}

function spawnSection(conn: DbConnection, zone: string, status: HTMLElement): HTMLElement {
  const section = commandSection("Spawn");
  const grid = document.createElement("div");
  grid.className = "command-spawn-grid";

  grid.appendChild(spawnButton("Boulder", itemIcon("boulder"), () => requestSpawn(conn, zone, status, { kind: "boulder" })));
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
  const label = request.kind === "boulder" ? "boulder" : request.kind === "hog" ? `${titleCaseWords(request.style)} Hog` : ITEMS[request.item].name;
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

function hogIcon(style: HogStyle): HTMLSpanElement {
  const frame = frameRect("hog", style, "down", "idle");
  const scale = 1;
  const icon = document.createElement("span");
  icon.className = "command-avatar-icon";
  icon.style.width = `${FRAME_W * scale}px`;
  icon.style.height = `${FRAME_H * scale}px`;
  icon.style.backgroundImage = `url("${avatarUrl}")`;
  icon.style.backgroundSize = `${SHEET_W * scale}px ${SHEET_H * scale}px`;
  icon.style.backgroundPosition = `-${frame.x * scale}px -${frame.y * scale}px`;
  return icon;
}

function titleCaseWords(value: string): string {
  return value
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
