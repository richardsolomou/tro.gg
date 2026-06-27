import { MAX_BOULDERS_PER_ZONE, MAX_HOGS_PER_ZONE, type Coord, type Zone } from "@trogg/shared";
import type { DbConnection } from "../net/module_bindings";
import { captureEvent } from "../analytics.js";
import { audio } from "../audio.js";
import { hudRoot } from "./hud.js";
import { currentCommandFlags, type ChatCommandFlags } from "./chat_commands.js";

type SpawnKind = "boulder" | "hog";

export interface CommandPanelContext {
  conn: DbConnection;
  zone: Zone;
  onGhost: (tile: Coord) => void;
}

/** Mount the pre-alpha command panel beside Help. It exposes the same debug
 * commands as chat, but as bounded controls for stress testing. */
export function mountCommands({ conn, zone, onGhost }: CommandPanelContext): void {
  const flags = currentCommandFlags();
  if (!flags.spawn && !flags.resetBoulders && !flags.resetHogs && !flags.ghost) return;

  const root = document.createElement("div");
  root.className = "panel commands";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "help-toggle command-toggle";
  toggle.textContent = "Commands";

  const body = document.createElement("div");
  body.className = "command-body";
  body.hidden = true;

  const status = document.createElement("div");
  status.className = "command-status";

  if (flags.spawn) body.appendChild(spawnSection(conn, status));
  if (flags.resetBoulders || flags.resetHogs) body.appendChild(resetSection(conn, zone.slug, flags, status));
  if (flags.ghost) body.appendChild(ghostSection(zone, onGhost, status));
  body.appendChild(status);

  toggle.addEventListener("click", () => {
    const opening = body.hidden;
    body.hidden = !opening;
    if (opening) window.dispatchEvent(new CustomEvent("hud-menu-open", { detail: "commands" }));
  });
  window.addEventListener("hud-menu-open", ((event: Event) => {
    if ((event as CustomEvent<string>).detail !== "commands") body.hidden = true;
  }) as EventListener);

  root.append(toggle, body);
  hudRoot().appendChild(root);
}

function spawnSection(conn: DbConnection, status: HTMLElement): HTMLElement {
  let kind: SpawnKind = "boulder";
  const section = commandSection("Spawn");

  const chooser = document.createElement("div");
  chooser.className = "command-segment";
  const boulder = segmentButton("Boulder", true);
  const hog = segmentButton("Hog", false);
  const choose = (next: SpawnKind) => {
    kind = next;
    boulder.setAttribute("aria-pressed", String(kind === "boulder"));
    hog.setAttribute("aria-pressed", String(kind === "hog"));
  };
  boulder.addEventListener("click", () => choose("boulder"));
  hog.addEventListener("click", () => choose("hog"));
  chooser.append(boulder, hog);

  const row = document.createElement("div");
  row.className = "command-row";
  const count = document.createElement("input");
  count.className = "field command-count";
  count.type = "number";
  count.min = "1";
  count.max = String(Math.max(MAX_BOULDERS_PER_ZONE, MAX_HOGS_PER_ZONE));
  count.step = "1";
  count.value = "5";
  count.setAttribute("aria-label", "Spawn count");
  const spawn = commandButton("Spawn selected");
  spawn.addEventListener("click", () => requestSpawn(conn, status, kind, readCount(count, capFor(kind))));
  row.append(count, spawn);

  const quick = document.createElement("div");
  quick.className = "command-grid";
  for (const n of [1, 5, 10, 25]) {
    const button = commandButton(`Spawn ${n}`);
    button.addEventListener("click", () => requestSpawn(conn, status, kind, n));
    quick.appendChild(button);
  }

  section.append(chooser, row, quick);
  return section;
}

function requestSpawn(conn: DbConnection, status: HTMLElement, kind: SpawnKind, count: number) {
  const label = kind === "hog" ? "Hogs" : "boulders";
  conn.reducers.spawn({ kind, count });
  audio.playCommand();
  status.textContent = `requested ${count} ${label}`;
}

function resetSection(conn: DbConnection, zone: string, flags: ChatCommandFlags, status: HTMLElement): HTMLElement {
  const section = commandSection("Reset");
  const grid = document.createElement("div");
  grid.className = "command-grid";

  if (flags.resetBoulders) {
    const button = commandButton("Reset boulders");
    button.addEventListener("click", () => {
      conn.reducers.resetBoulders({});
      captureEvent("boulders_reset", { zone });
      audio.playCommand();
      status.textContent = "reset boulders";
    });
    grid.appendChild(button);
  }

  if (flags.resetHogs) {
    const button = commandButton("Reset Hogs");
    button.addEventListener("click", () => {
      conn.reducers.resetHogs({});
      captureEvent("hedgehogs_reset", { zone });
      audio.playCommand();
      status.textContent = "reset Hogs";
    });
    grid.appendChild(button);
  }

  if (flags.resetBoulders && flags.resetHogs) {
    const button = commandButton("Reset both");
    button.addEventListener("click", () => {
      conn.reducers.resetBoulders({});
      conn.reducers.resetHogs({});
      captureEvent("boulders_reset", { zone });
      captureEvent("hedgehogs_reset", { zone });
      audio.playCommand();
      status.textContent = "reset boulders and Hogs";
    });
    grid.appendChild(button);
  }

  section.appendChild(grid);
  return section;
}

function ghostSection(zone: Zone, onGhost: (tile: Coord) => void, status: HTMLElement): HTMLElement {
  const section = commandSection("Ghost");
  const grid = document.createElement("div");
  grid.className = "command-grid";

  const once = commandButton("Ghost once");
  once.addEventListener("click", () => {
    haunt(zone, onGhost, 1);
    status.textContent = "flickered one ghost";
  });

  const burst = commandButton("Ghost burst");
  burst.addEventListener("click", () => {
    haunt(zone, onGhost, 8);
    status.textContent = "flickered eight ghosts";
  });

  grid.append(once, burst);
  section.appendChild(grid);
  return section;
}

function haunt(zone: Zone, onGhost: (tile: Coord) => void, count: number) {
  for (let i = 0; i < count; i++) {
    onGhost({ x: Math.floor(Math.random() * zone.width), y: Math.floor(Math.random() * zone.height) });
  }
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

function segmentButton(label: string, pressed: boolean): HTMLButtonElement {
  const button = commandButton(label);
  button.setAttribute("aria-pressed", String(pressed));
  return button;
}

function readCount(input: HTMLInputElement, cap: number): number {
  const value = Number(input.value);
  if (!Number.isSafeInteger(value)) return 1;
  return Math.max(1, Math.min(cap, value));
}

function capFor(kind: SpawnKind): number {
  return kind === "boulder" ? MAX_BOULDERS_PER_ZONE : MAX_HOGS_PER_ZONE;
}
