import { Application, Container, Graphics, Sprite, Text } from "pixi.js";
import { CHAT_BUBBLE_MS, COLOR_UNSET, facingTile, FRAME_H, getZone, projectMotion, STARTING_ZONE_SLUG, troggColorFor, zoneBounds, type Facing, type Kind } from "@trogg/shared";
import type { DbConnection } from "./module_bindings";
import type { Boulder, Hog, Player } from "./module_bindings/types";
import { attachKeyboard } from "./input.js";
import { mountChat, type ChatUI } from "./chat.js";
import { createTerrain } from "./terrain.js";
import { avatarFrame, avatarTexture, facingFromDir } from "./avatars.js";
import { captureEvent, isFeatureEnabled } from "./analytics.js";

/** Art pixels per tile — terrain tiles are drawn at this and scaled up crisply. */
const ART = 16;
/** Fraction of the viewport the zone fills, leaving a rim of cave around it. */
const ZONE_FILL = 0.92;
/** Screen pixels per tile, sized to the viewport in `layout`. */
let TILE = 28;

/** A player's sprite plus the client-clock instant its current intent arrived. */
interface Tracked {
  marker: Container;
  /** The trogg sprite, or undefined when the `avatar-sprites` flag is off. */
  sprite?: Sprite;
  player: Player;
  baseMs: number;
  /** Last facing, kept so an idle trogg holds its heading rather than snapping. */
  facing: Facing;
  /** The frame key currently on the sprite, so the ticker only swaps on change. */
  frameKey: string;
  bubble?: Container;
  bubbleTimer?: ReturnType<typeof setTimeout>;
}

/** Screen-space y of the top of a trogg's head, for placing labels and bubbles. */
function headTopY(): number {
  return TILE - FRAME_H * (TILE / ART);
}

/** A boulder's live row plus its sprite. */
interface BoulderView {
  row: Boulder;
  sprite: Container;
}

/** A roaming Hog's sprite plus the client-clock instant its current intent arrived. */
interface HogView {
  marker: Container;
  sprite: Sprite;
  row: Hog;
  baseMs: number;
  facing: Facing;
  frameKey: string;
}

/** "x,y" key for a tile, matching the server's occupancy keys. */
const tileKey = (x: number, y: number) => `${x},${y}`;

/**
 * Renders the zone: a tile grid plus a marker per player. Movement is intent-
 * based (GDD "Movement") — the `player` table syncs each trogg's origin,
 * direction, and start time, and every client extrapolates position locally each
 * frame so motion is smooth without per-frame server sync (invariant 2). Zone
 * dimensions come from the static `ZONES` registry (shared by client and module).
 * PixiJS is the renderer per the GDD "Camera and rendering" section.
 */
export function mountWorld(app: Application, conn: DbConnection) {
  const slug = STARTING_ZONE_SLUG;
  const zone = getZone(slug)!;
  const myId = conn.identity?.toHexString();
  // Sprite avatars replace the placeholder marker behind a flag (invariant 5);
  // the kill-switch falls back to the colour marker, like `chat-enabled`.
  const useSprites = isFeatureEnabled("avatar-sprites");
  // Ambient roaming Hogs render behind their own flag (invariant 5; kill-switch).
  const useHogs = isFeatureEnabled("roaming-hogs");

  // Tiles boulders currently occupy. Folded into the collision context below so
  // troggs stop flush against boulders exactly as they do against walls — and so
  // client prediction confines them to the same tiles the server does.
  const boulderTiles = new Set<string>();
  const bounds = zoneBounds(zone, (x, y) => boulderTiles.has(tileKey(x, y)));

  const terrain = createTerrain(zone);
  const stage = new Container();
  // Background rock fills the screen behind the zone; the stage carries the floor
  // + walls + boulders + markers and is centred; the vignette darkens edges on top.
  app.stage.addChild(terrain.background, stage, terrain.vignette);
  stage.addChild(terrain.ground);
  const boulderLayer = new Container();
  const hogLayer = new Container();
  stage.addChild(boulderLayer, hogLayer);

  const tracked = new Map<string, Tracked>();
  const boulders = new Map<string, BoulderView>();
  const hogs = new Map<string, HogView>();

  const layout = () => {
    const { width: vw, height: vh } = app.renderer;
    const fit = Math.min((vw * ZONE_FILL) / bounds.width, (vh * ZONE_FILL) / bounds.height);
    TILE = Math.max(ART, Math.floor(fit));
    terrain.layout(TILE, vw, vh);
    centre(app, stage, bounds.width, bounds.height);
    // Markers and boulder sprites bake TILE into their size, so resize redraws them.
    for (const [id, entry] of tracked) rebuildMarker(id, entry);
    for (const view of boulders.values()) {
      view.sprite.destroy({ children: true });
      view.sprite = makeBoulder();
      place(view.sprite, view.row.x, view.row.y);
      boulderLayer.addChild(view.sprite);
    }
    // Hog sprites bake TILE into their scale too; the ticker repositions them next frame.
    for (const view of hogs.values()) {
      view.marker.destroy({ children: true });
      const built = makeHog(view.facing);
      view.marker = built.marker;
      view.sprite = built.sprite;
      view.frameKey = built.frameKey;
      place(view.marker, view.row.x, view.row.y);
      hogLayer.addChild(view.marker);
    }
  };

  const rebuildMarker = (id: string, entry: Tracked) => {
    if (entry.bubbleTimer) clearTimeout(entry.bubbleTimer);
    entry.marker.destroy({ children: true });
    const built = makeMarker(entry.player.name, troggColorFor(entry.player.color, id), id === myId, entry.facing, useSprites);
    entry.marker = built.marker;
    entry.sprite = built.sprite;
    entry.frameKey = built.frameKey;
    entry.bubble = undefined;
    entry.bubbleTimer = undefined;
    const { x, y } = projectMotion(entry.player, performance.now() - entry.baseMs, bounds);
    place(entry.marker, x, y);
    stage.addChild(entry.marker);
  };

  app.renderer.on("resize", layout);
  layout();

  const addPlayer = (p: Player) => {
    const id = p.identity.toHexString();
    if (tracked.has(id)) return;
    const facing = facingFromDir(p.dirX, p.dirY, "down");
    const { marker, sprite, frameKey } = makeMarker(p.name, troggColorFor(p.color, id), id === myId, facing, useSprites);
    const entry: Tracked = { marker, sprite, player: p, baseMs: performance.now(), facing, frameKey };
    place(marker, p.x, p.y);
    tracked.set(id, entry);
    stage.addChild(marker);
  };

  const removePlayer = (id: string) => {
    const entry = tracked.get(id);
    if (entry?.bubbleTimer) clearTimeout(entry.bubbleTimer);
    entry?.marker.destroy({ children: true });
    tracked.delete(id);
  };

  conn.db.player.onInsert((_ctx, p) => addPlayer(p));
  conn.db.player.onUpdate((_ctx, _old, p) => {
    const id = p.identity.toHexString();
    const entry = tracked.get(id);
    if (!entry) return addPlayer(p);
    // Rebase extrapolation on every new intent so elapsed is measured in client
    // time — no server-clock sync needed, and each update reconciles drift.
    entry.player = p;
    entry.baseMs = performance.now();
    // The nameplate and tint are baked into the marker at build time, so a rename
    // or recolour only shows once the marker is rebuilt from the updated row.
    if (_old.name !== p.name || _old.color !== p.color) rebuildMarker(id, entry);
  });
  conn.db.player.onDelete((_ctx, p) => removePlayer(p.identity.toHexString()));

  const syncBoulderTiles = () => {
    boulderTiles.clear();
    for (const view of boulders.values()) boulderTiles.add(tileKey(view.row.x, view.row.y));
  };
  const upsertBoulder = (b: Boulder) => {
    const key = b.id.toString();
    let view = boulders.get(key);
    if (!view) {
      view = { row: b, sprite: makeBoulder() };
      boulders.set(key, view);
      boulderLayer.addChild(view.sprite);
    } else {
      view.row = b;
    }
    place(view.sprite, b.x, b.y);
    syncBoulderTiles();
  };
  const removeBoulder = (b: Boulder) => {
    const view = boulders.get(b.id.toString());
    view?.sprite.destroy({ children: true });
    boulders.delete(b.id.toString());
    syncBoulderTiles();
  };

  conn.db.boulder.onInsert((_ctx, b) => upsertBoulder(b));
  conn.db.boulder.onUpdate((_ctx, _old, b) => upsertBoulder(b));
  conn.db.boulder.onDelete((_ctx, b) => removeBoulder(b));

  const addHog = (h: Hog) => {
    const id = h.id.toString();
    if (hogs.has(id)) return;
    const facing = facingFromDir(h.dirX, h.dirY, "down");
    const { marker, sprite, frameKey } = makeHog(facing);
    place(marker, h.x, h.y);
    hogs.set(id, { marker, sprite, row: h, baseMs: performance.now(), facing, frameKey });
    hogLayer.addChild(marker);
  };
  const updateHog = (h: Hog) => {
    const view = hogs.get(h.id.toString());
    if (!view) return addHog(h);
    // Rebase extrapolation on each new intent, like a player (see player.onUpdate).
    view.row = h;
    view.baseMs = performance.now();
  };
  const removeHog = (h: Hog) => {
    const view = hogs.get(h.id.toString());
    view?.marker.destroy({ children: true });
    hogs.delete(h.id.toString());
  };

  // Roaming Hogs render behind their own flag (invariant 5; kill-switch).
  if (useHogs) {
    conn.db.hog.onInsert((_ctx, h) => addHog(h));
    conn.db.hog.onUpdate((_ctx, _old, h) => updateHog(h));
    conn.db.hog.onDelete((_ctx, h) => removeHog(h));
  }

  // Pushing is gated behind its flag (invariant 5); off → boulders are immovable
  // rocks, on → a trogg shoves the one it walks squarely into. We fire `push` only
  // on the transition into "facing a boulder", never per frame (invariant 2); the
  // server validates and re-bases motion, so the boulder slides at most one tile
  // per tile walked (GDD "Pushing").
  const pushEnabled = isFeatureEnabled("boulder-pushing");
  let pushing = false;

  app.ticker.add(() => {
    const now = performance.now();
    for (const entry of tracked.values()) {
      const { x, y } = projectMotion(entry.player, now - entry.baseMs, bounds);
      place(entry.marker, x, y);
      animate(entry, now);

      if (!pushEnabled || entry.player.identity.toHexString() !== myId) continue;
      const ahead = facingTile(x, y, entry.player.dirX, entry.player.dirY);
      const facingBoulder = ahead != null && boulderTiles.has(tileKey(ahead.x, ahead.y));
      if (facingBoulder && !pushing) conn.reducers.push({});
      pushing = facingBoulder;
    }

    // Hogs ride the same intent extrapolation — derived locally, never per-frame
    // sync (invariant 2). They collide against the same walls and boulders.
    for (const view of hogs.values()) {
      const { x, y } = projectMotion(view.row, now - view.baseMs, bounds);
      place(view.marker, x, y);
      driveSprite(view.sprite, "hog", view.row.dirX, view.row.dirY, view, now);
    }
  });

  attachKeyboard(conn);

  // Live once the initial rows have been delivered: backlog chat fills the
  // history panel silently, while later inserts also pop a bubble.
  const sub = { live: false };
  if (isFeatureEnabled("chat-enabled")) setupChat(conn, tracked, slug, sub, myId);

  const queries = [
    `SELECT * FROM player WHERE zone_id = '${slug}' AND online = true`,
    `SELECT * FROM chat_message WHERE zone_id = '${slug}'`,
    `SELECT * FROM boulder WHERE zone_id = '${slug}'`,
  ];
  if (useHogs) queries.push(`SELECT * FROM hog WHERE zone_id = '${slug}'`);

  conn
    .subscriptionBuilder()
    .onApplied(() => (sub.live = true))
    .subscribe(queries);
}

/**
 * Wires zone chat: every `chat_message` row feeds the side-panel history (the
 * subscription replays recent lines on join), and once live, a new row also pops
 * a bubble over the speaker's head — so bubbles fire only for present players,
 * not the backlog. Own messages emit `chat_sent` — never content (invariant 4 /
 * docs/analytics.md).
 */
function setupChat(
  conn: DbConnection,
  tracked: Map<string, Tracked>,
  slug: string,
  sub: { live: boolean },
  myId: string | undefined,
) {
  // The `/spawn` debug command is typed in the chat box but isn't a chat line —
  // it spawns an entity at the caller's tile (server-authoritative) instead of
  // broadcasting. Behind its own flag (invariant 5); off → it's sent as plain chat.
  // Defaults on in local dev, off in a production build (PostHog can flip it on).
  const spawnEnabled = isFeatureEnabled("spawn-command", import.meta.env.DEV);
  const resetEnabled = isFeatureEnabled("boulder-reset");
  const chat = mountChat((text) => {
    if (spawnEnabled && handleSpawnCommand(conn, chat, text)) return;
    if (resetEnabled && handleResetCommand(conn, slug, text)) return;
    conn.reducers.chat({ text });
  });

  const senderColor = (sender: Player["identity"]) =>
    troggColorFor(conn.db.player.identity.find(sender)?.color ?? COLOR_UNSET, sender.toHexString());

  conn.db.chatMessage.onInsert((_ctx, message) => {
    const senderId = message.sender.toHexString();
    chat.addMessage(senderId, message.name, message.text, senderColor(message.sender));
    // Bubble only for fresh lines: a reconnect replays the zone's recent history,
    // and those rows can arrive after the subscription goes live — without this an
    // old message would pop a stale bubble over its sender on every refresh.
    const ageMs = Date.now() - Number(message.createdAt.microsSinceUnixEpoch / 1000n);
    if (ageMs > CHAT_BUBBLE_MS) return;
    showBubble(tracked, senderId, message.text);
    if (sub.live && senderId === myId) captureEvent("chat_sent", { zone: slug });
  });

  // A rename rewrites the denormalised name on the sender's past lines; reflect it
  // in the history panel so it doesn't show their old name until a reload.
  conn.db.chatMessage.onUpdate((_ctx, _old, message) => {
    chat.renameSender(message.sender.toHexString(), message.name);
  });

  // Colour isn't denormalised onto chat rows (it's derived from the live player
  // row), so a recolour surfaces as a player-row update — retint the sender's
  // history lines so they match the avatar without a reload.
  conn.db.player.onUpdate((_ctx, _old, p) => {
    if (_old.color !== p.color) chat.recolorSender(p.identity.toHexString(), troggColorFor(p.color, p.identity.toHexString()));
  });
}

/** The world-facing `/spawn` arguments mapped to their entity kind in the module. */
const SPAWNABLE: Record<string, "boulder" | "hog"> = { boulder: "boulder", hedgehog: "hog", hog: "hog" };

/**
 * Handle a chat line as a `/spawn <entity>` command. Returns true if it was a
 * spawn command (so the caller skips sending it as chat): a known entity fires
 * the `spawn` reducer; an unknown one or bad syntax posts a local usage hint.
 * Anything not starting with `/spawn` returns false and falls through to chat.
 */
function handleSpawnCommand(conn: DbConnection, chat: ChatUI, text: string): boolean {
  const m = /^\/spawn(?:\s+(\S+))?\s*$/i.exec(text);
  if (!m) return false;

  const hint = (msg: string) => chat.addMessage("spawn", "spawn", msg, 0x9a8c70);
  const arg = m[1]?.toLowerCase();
  if (!arg) {
    hint("usage: /spawn boulder | hedgehog");
    return true;
  }
  const kind = SPAWNABLE[arg];
  if (!kind) {
    hint(`unknown entity "${arg}" — try boulder or hedgehog`);
    return true;
  }
  conn.reducers.spawn({ kind });
  return true;
}

/**
 * Handle a chat line as the `/reset` command: snap the caller's zone boulders back
 * to their registry layout (server-authoritative) instead of broadcasting. Returns
 * true if it was the command; anything else falls through to chat.
 */
function handleResetCommand(conn: DbConnection, zone: string, text: string): boolean {
  if (!/^\/reset\s*$/i.test(text)) return false;
  conn.reducers.resetBoulders({});
  captureEvent("boulders_reset", { zone });
  return true;
}

/** Pop a speech bubble over a trogg's head, replacing any current one. */
function showBubble(tracked: Map<string, Tracked>, id: string, text: string) {
  const entry = tracked.get(id);
  if (!entry) return;

  if (entry.bubbleTimer) clearTimeout(entry.bubbleTimer);
  entry.bubble?.destroy({ children: true });

  const bubble = makeBubble(text, entry.sprite ? headTopY() : 0);
  entry.marker.addChild(bubble);
  entry.bubble = bubble;
  entry.bubbleTimer = setTimeout(() => {
    bubble.destroy({ children: true });
    if (entry.bubble === bubble) {
      entry.bubble = undefined;
      entry.bubbleTimer = undefined;
    }
  }, CHAT_BUBBLE_MS);
}

function makeBubble(text: string, topY: number): Container {
  const bubble = new Container();
  const label = new Text({
    text,
    style: { fontFamily: "monospace", fontSize: 11, fill: 0x0a0806, align: "center", wordWrap: true, wordWrapWidth: 150 },
  });
  label.anchor.set(0.5, 1);
  const padX = 5;
  const padY = 3;
  const bg = new Graphics()
    .roundRect(-label.width / 2 - padX, -label.height - padY, label.width + padX * 2, label.height + padY * 2, 4)
    .fill(0xe8dcc4);
  label.position.set(0, padY);
  bubble.addChild(bg, label);
  // Float just above the head (the head top in sprite mode, the cell top for the
  // placeholder marker).
  bubble.position.set(TILE / 2, topY - 16);
  return bubble;
}

/**
 * A trogg. With the `avatar-sprites` flag on, it's the layered avatar sprite
 * (GDD "Avatars and equipment") tinted by the player's stable colour, feet at
 * the bottom-centre of the tile cell and head extending up out of it — so the
 * per-player colour, formerly the whole marker, now rides as a tint, keeping
 * "the same trogg is the same colour for everyone". With the flag off it's the
 * placeholder colour marker (a tile-filling rect). Both carry a name label.
 */
function makeMarker(name: string, color: number, self: boolean, facing: Facing, sprites: boolean) {
  const marker = new Container();
  let sprite: Sprite | undefined;
  let frameKey = "";

  if (sprites) {
    const frame = avatarFrame(false, 0);
    // Self gets a bright ground ring under the feet so you can pick yourself out.
    if (self) {
      const ring = new Graphics()
        .ellipse(TILE / 2, TILE - 1, TILE * 0.34, TILE * 0.16)
        .stroke({ width: 2, color: 0xe8dcc4 });
      marker.addChild(ring);
    }
    sprite = new Sprite(avatarTexture("trogg", facing, frame));
    sprite.anchor.set(0.5, 1);
    sprite.scale.set(TILE / ART);
    sprite.position.set(TILE / 2, TILE);
    sprite.tint = color;
    marker.addChild(sprite);
    frameKey = `${facing}_${frame}`;
  } else {
    const body = new Graphics().rect(2, 2, TILE - 4, TILE - 4).fill(color);
    // Your own trogg keeps its colour but gets an outline so you can pick it out.
    if (self) body.rect(2, 2, TILE - 4, TILE - 4).stroke({ width: 2, color: 0xe8dcc4 });
    marker.addChild(body);
  }

  const label = new Text({
    text: name,
    style: { fontFamily: "monospace", fontSize: 11, fill: 0xe8dcc4 },
  });
  label.anchor.set(0.5, 1);
  label.position.set(TILE / 2, sprites ? headTopY() - 2 : -2);
  marker.addChild(label);

  return { marker, sprite, frameKey };
}

/** Drive a trogg's facing and walk cycle from its synced motion intent. No-op
 *  for the placeholder marker (no sprite to swap). */
function animate(entry: Tracked, now: number) {
  if (!entry.sprite) return;
  driveSprite(entry.sprite, "trogg", entry.player.dirX, entry.player.dirY, entry, now);
}

/**
 * Point a sprite's facing and walk frame at its motion intent, mutating the
 * caller's `facing`/`frameKey` so the next frame compares against it. Shared by
 * troggs and Hogs (one rig). Only touches the GPU when the frame actually changes.
 */
function driveSprite(
  sprite: Sprite,
  kind: Kind,
  dirX: number,
  dirY: number,
  state: { facing: Facing; frameKey: string },
  now: number,
) {
  const moving = dirX !== 0 || dirY !== 0;
  state.facing = facingFromDir(dirX, dirY, state.facing);
  const frame = avatarFrame(moving, now);
  const key = `${state.facing}_${frame}`;
  if (key === state.frameKey) return;
  sprite.texture = avatarTexture(kind, state.facing, frame);
  state.frameKey = key;
}

/** A pushable boulder: a rounded stone filling its tile, with a lit top-left face. */
function makeBoulder() {
  const sprite = new Container();
  const inset = Math.max(2, Math.round(TILE * 0.1));
  const size = TILE - inset * 2;
  const radius = Math.max(3, Math.round(TILE * 0.28));
  const px = Math.max(1, Math.round(TILE / ART));
  const body = new Graphics()
    .roundRect(inset, inset, size, size, radius)
    .fill(0x6b5640)
    .stroke({ width: px, color: 0x2a2118, alignment: 0 });
  // A small highlight reads as a lit facet under the cave's torchlight.
  body.roundRect(inset + px, inset + px, size * 0.4, size * 0.4, radius * 0.6).fill(0x8a7257);
  sprite.addChild(body);
  return sprite;
}

/** A roaming Hog: the shared avatar sprite in its hedgehog skin, feet on the tile.
 *  No name label, tint, or ground ring — Hogs are ambient scenery, not players. */
function makeHog(facing: Facing): { marker: Container; sprite: Sprite; frameKey: string } {
  const marker = new Container();
  const frame = avatarFrame(false, 0);
  const sprite = new Sprite(avatarTexture("hog", facing, frame));
  sprite.anchor.set(0.5, 1);
  sprite.scale.set(TILE / ART);
  sprite.position.set(TILE / 2, TILE);
  marker.addChild(sprite);
  return { marker, sprite, frameKey: `${facing}_${frame}` };
}

function place(marker: Container, x: number, y: number) {
  marker.position.set(x * TILE, y * TILE);
}

function centre(app: Application, stage: Container, width: number, height: number) {
  stage.position.set(
    (app.renderer.width - width * TILE) / 2,
    (app.renderer.height - height * TILE) / 2,
  );
}
