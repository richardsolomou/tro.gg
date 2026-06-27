import type { Coord, Zone } from "@trogg/shared";
import type { DbConnection } from "../net/module_bindings";
import type { ChatUI } from "./chat.js";
import { captureEvent } from "../analytics.js";
import { audio } from "../audio.js";

/** Which slash commands are live (each behind its own feature flag, resolved by the caller). */
export interface ChatCommandFlags {
  spawn: boolean;
  resetBoulders: boolean;
  resetHogs: boolean;
  ghost: boolean;
}

export interface ChatCommandContext {
  conn: DbConnection;
  chat: ChatUI;
  zone: Zone;
  flags: ChatCommandFlags;
  /** Flicker the cosmetic ghost at a tile — the one rendering effect a command needs,
   *  injected so this module stays pure dispatch (no renderer). */
  onGhost: (tile: Coord) => void;
}

/**
 * Try to handle a chat line as a slash command, returning true if it was one (so the
 * caller skips broadcasting it as chat). `/spawn` and `/reset` fire server reducers;
 * `/ghost` is a client-only cosmetic. Anything else returns false and falls through to
 * chat. Each command is gated by its flag; a disabled command is just an ordinary line.
 */
export function handleChatCommand(text: string, ctx: ChatCommandContext): boolean {
  const { conn, chat, zone, flags, onGhost } = ctx;
  if (flags.spawn && handleSpawnCommand(conn, chat, zone.slug, text)) return true;
  if (handleResetCommand(conn, chat, zone.slug, text, flags.resetBoulders, flags.resetHogs)) return true;
  if (flags.ghost && handleGhostCommand(text, zone, onGhost)) return true;
  return false;
}

/** The world-facing `/spawn` arguments mapped to their entity kind in the module. */
const SPAWNABLE: Record<string, "boulder" | "hog"> = { boulder: "boulder", hedgehog: "hog", hog: "hog" };

/**
 * Handle a chat line as a `/spawn <entity>` command. Returns true if it was a spawn
 * command (so the caller skips sending it as chat): a known entity fires the `spawn`
 * reducer; an unknown one or bad syntax posts a local usage hint. Anything not starting
 * with `/spawn` returns false and falls through to chat.
 */
function handleSpawnCommand(conn: DbConnection, chat: ChatUI, zone: string, text: string): boolean {
  const m = /^\/spawn(?:\s+(\S+))?\s*$/i.exec(text);
  if (!m) return false;

  const hint = (msg: string) => chat.addMessage("spawn", "spawn", msg, 0x9a8c70);
  const arg = m[1]?.toLowerCase();
  if (!arg) {
    audio.playError();
    console.warn("Rejected spawn command", { zone, reason: "missing_kind" });
    hint("usage: /spawn boulder | hedgehog");
    return true;
  }
  const kind = SPAWNABLE[arg];
  if (!kind) {
    audio.playError();
    console.warn("Rejected spawn command", { zone, reason: "unknown_kind" });
    hint(`unknown entity "${arg}" — try boulder or hedgehog`);
    return true;
  }
  audio.playCommand();
  conn.reducers.spawn({ kind });
  captureEvent("debug_entity_spawned", { zone, kind });
  console.info("Debug entity spawned", { zone, kind });
  return true;
}

/** The `/reset` targets mapped to a stable key, so aliases resolve to one branch. */
const RESET_TARGETS: Record<string, "boulders" | "hogs"> = {
  boulder: "boulders",
  boulders: "boulders",
  hog: "hogs",
  hogs: "hogs",
  hedgehog: "hogs",
  hedgehogs: "hogs",
};

/**
 * Handle a chat line as the `/reset [boulders|hedgehogs]` command: snap the caller's
 * zone boulders or Hogs back to their registry layout (server-authoritative) instead
 * of broadcasting. Bare `/reset` resets boulders, the original behaviour. Each target
 * is independently flag-gated (`boulder-reset` / `hog-reset`); a target whose flag is
 * off, or an unknown one, posts a local usage hint. Returns true if the line was a
 * `/reset` command; anything else falls through to chat.
 */
function handleResetCommand(
  conn: DbConnection,
  chat: ChatUI,
  zone: string,
  text: string,
  bouldersEnabled: boolean,
  hogsEnabled: boolean,
): boolean {
  const m = /^\/reset(?:\s+(\S+))?\s*$/i.exec(text);
  if (!m) return false;
  // With neither target enabled, `/reset` isn't a command at all — fall through so
  // it sends as an ordinary chat line (the prior behaviour when `boulder-reset` was off).
  if (!bouldersEnabled && !hogsEnabled) return false;

  const hint = (msg: string) => chat.addMessage("reset", "reset", msg, 0x9a8c70);
  const targets = [bouldersEnabled && "boulders", hogsEnabled && "hedgehogs"].filter(Boolean).join(" | ");
  const target = m[1] ? RESET_TARGETS[m[1].toLowerCase()] : "boulders";

  if (target === "boulders" && bouldersEnabled) {
    audio.playCommand();
    conn.reducers.resetBoulders({});
    captureEvent("boulders_reset", { zone });
    return true;
  }
  if (target === "hogs" && hogsEnabled) {
    audio.playCommand();
    conn.reducers.resetHogs({});
    captureEvent("hedgehogs_reset", { zone });
    return true;
  }

  audio.playError();
  hint(`usage: /reset ${targets}`);
  return true;
}

/**
 * Handle a chat line as the `/ghost` command: flicker the cosmetic ghost trogg at a
 * random tile in the zone via `onGhost`. Purely a client render (touches no table or
 * reducer), so only the caller sees it. Returns true if it was the command; anything
 * else falls through to chat.
 */
function handleGhostCommand(text: string, zone: Zone, onGhost: (tile: Coord) => void): boolean {
  if (!/^\/ghost\s*$/i.test(text)) return false;
  onGhost({ x: Math.floor(Math.random() * zone.width), y: Math.floor(Math.random() * zone.height) });
  return true;
}
