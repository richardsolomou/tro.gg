import { MAX_BOULDERS_PER_ZONE, MAX_HOGS_PER_ZONE, type Zone } from "@trogg/shared";
import type { DbConnection } from "../net/module_bindings";
import type { ChatUI } from "./chat.js";
import { captureEvent, isFeatureEnabled, logInfo, logWarn } from "../analytics.js";
import { audio } from "../audio.js";
import { POSTHOG_KEY } from "../env.js";

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
}

/** Resolve the live command flags once per mounted HUD surface. */
export function currentCommandFlags(): ChatCommandFlags {
  return {
    spawn: isFeatureEnabled("spawn-command", import.meta.env.DEV || !POSTHOG_KEY),
    resetBoulders: isFeatureEnabled("boulder-reset"),
    resetHogs: isFeatureEnabled("hog-reset"),
    ghost: isFeatureEnabled("ghost-trogg"),
  };
}

/**
 * Try to handle a chat line as a slash command, returning true if it was one (so the
 * caller skips broadcasting it as chat). `/spawn`, `/reset`, and `/ghost` fire server
 * reducers. Anything else returns false and falls through to chat. Each command is
 * gated by its flag; a disabled command is just an ordinary line.
 */
export function handleChatCommand(text: string, ctx: ChatCommandContext): boolean {
  const { conn, chat, zone, flags } = ctx;
  if (flags.spawn && handleSpawnCommand(conn, chat, zone.slug, text)) return true;
  if (handleResetCommand(conn, chat, zone.slug, text, flags.resetBoulders, flags.resetHogs)) return true;
  if (flags.ghost && handleGhostCommand(conn, zone.slug, text)) return true;
  return false;
}

/** The world-facing `/spawn` arguments mapped to their entity kind in the module. */
const SPAWNABLE: Record<string, "boulder" | "hog"> = { boulder: "boulder", hedgehog: "hog", hog: "hog" };

/**
 * Handle a chat line as a `/spawn <entity> [count]` command. Returns true if it
 * was a spawn command (so the caller skips sending it as chat): a known entity
 * fires the `spawn` reducer; an unknown one or bad syntax posts a local usage
 * hint. The server enforces the real cap; the client range is just a friendlier
 * pre-alpha control. Anything not starting with `/spawn` returns false and falls
 * through to chat.
 */
function handleSpawnCommand(conn: DbConnection, chat: ChatUI, zone: string, text: string): boolean {
  const m = /^\/spawn(?:\s+(\S+)(?:\s+(\S+))?)?\s*$/i.exec(text);
  if (!m) return false;

  const hint = (msg: string) => chat.addMessage("spawn", "spawn", msg, 0x9a8c70);
  const first = m[1]?.toLowerCase();
  const second = m[2]?.toLowerCase();
  if (!first) {
    audio.playError();
    logWarn("Rejected spawn command", { zone, reason: "missing_kind" });
    hint("usage: /spawn boulder [count] | hedgehog [count]");
    return true;
  }

  const countFirst = parseSpawnCount(first);
  const arg = countFirst ? second : first;
  const countArg = countFirst ? first : second;
  const kind = arg ? SPAWNABLE[arg] : undefined;
  if (!kind) {
    audio.playError();
    logWarn("Rejected spawn command", { zone, reason: "unknown_kind" });
    hint(`unknown entity "${arg ?? first}" — try boulder or hedgehog`);
    return true;
  }

  const count = countArg ? parseSpawnCount(countArg) : 1;
  if (!count) {
    audio.playError();
    logWarn("Rejected spawn command", { zone, reason: "invalid_count" });
    hint(`count must be 1-${kind === "boulder" ? MAX_BOULDERS_PER_ZONE : MAX_HOGS_PER_ZONE}`);
    return true;
  }
  audio.playCommand();
  conn.reducers.spawn({ kind, count });
  captureEvent("debug_entity_spawned", { zone, kind, count, source: "chat" });
  logInfo("Debug entity spawn requested", { zone, kind, count, source: "chat" });
  return true;
}

function parseSpawnCount(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
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
    captureEvent("boulders_reset", { zone, source: "chat" });
    return true;
  }
  if (target === "hogs" && hogsEnabled) {
    audio.playCommand();
    conn.reducers.resetHogs({});
    captureEvent("hedgehogs_reset", { zone, source: "chat" });
    return true;
  }

  audio.playError();
  hint(`usage: /reset ${targets}`);
  return true;
}

/**
 * Handle a chat line as the `/ghost` command: request a server-picked, zone-scoped
 * cosmetic haunt. Returns true if it was the command; anything else falls through to chat.
 */
function handleGhostCommand(conn: DbConnection, zone: string, text: string): boolean {
  if (!/^\/ghost\s*$/i.test(text)) return false;
  conn.reducers.hauntGhost({});
  captureEvent("ghost_summoned", { zone, source: "chat", count: 1 });
  return true;
}
