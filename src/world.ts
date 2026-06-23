import { Application, Container, Graphics, Sprite, Text } from "pixi.js";
import { CHAT_BUBBLE_MS, facingTile, FRAME_H, getZone, projectMotion, snapToTile, STARTING_ZONE_SLUG, troggColor, zoneBounds, type Facing } from "@trogg/shared";
import type { DbConnection } from "./module_bindings";
import type { Boulder, Player } from "./module_bindings/types";
import { attachKeyboard, type MoveIntent } from "./input.js";
import { mountChat } from "./chat.js";
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

/** "x,y" key for a tile, matching the server's occupancy keys. */
const tileKey = (x: number, y: number) => `${x},${y}`;

const sameIntent = (a: MoveIntent, b: MoveIntent) => a.dirX === b.dirX && a.dirY === b.dirY;
const isIdle = (i: MoveIntent) => i.dirX === 0 && i.dirY === 0;

/**
 * Has the trogg reached a tile centre on the axis it's moving along, since the last
 * frame? True when it lands on one (within float slack — also covers a trogg parked
 * flush against a wall) or crosses one between frames (moving at speed, a centre can
 * fall between two frames). `prev` is NaN on the first frame of a motion, where the
 * origin is already a centre, so treat that as reached.
 */
function reachedCentre(intent: MoveIntent, prevX: number, prevY: number, x: number, y: number): boolean {
  const prev = intent.dirX !== 0 ? prevX : prevY;
  const cur = intent.dirX !== 0 ? x : y;
  if (Number.isNaN(prev)) return true;
  if (Math.abs(cur - Math.round(cur)) < 1e-3) return true;
  return Math.floor(prev) !== Math.floor(cur);
}

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
  stage.addChild(boulderLayer);

  const tracked = new Map<string, Tracked>();
  const boulders = new Map<string, BoulderView>();

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
  };

  const rebuildMarker = (id: string, entry: Tracked) => {
    if (entry.bubbleTimer) clearTimeout(entry.bubbleTimer);
    entry.marker.destroy({ children: true });
    const built = makeMarker(entry.player.name, troggColor(id), id === myId, entry.facing, useSprites);
    entry.marker = built.marker;
    entry.sprite = built.sprite;
    entry.frameKey = built.frameKey;
    entry.bubble = undefined;
    entry.bubbleTimer = undefined;
    stage.addChild(entry.marker);
  };

  app.renderer.on("resize", layout);
  layout();

  const addPlayer = (p: Player) => {
    const id = p.identity.toHexString();
    if (tracked.has(id)) return;
    const facing = facingFromDir(p.dirX, p.dirY, "down");
    const { marker, sprite, frameKey } = makeMarker(p.name, troggColor(id), id === myId, facing, useSprites);
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
    const entry = tracked.get(p.identity.toHexString());
    if (!entry) return addPlayer(p);
    // Rebase extrapolation on every new intent so elapsed is measured in client
    // time — no server-clock sync needed, and each update reconciles drift.
    entry.player = p;
    entry.baseMs = performance.now();
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

  const pushEnabled = isFeatureEnabled("boulder-pushing");
  let pushing = false;

  // My-trogg movement is grid-locked (GDD "Movement", Pokémon/Zelda style): the
  // `move` reducer fires only when the trogg sits on a tile centre, so a step always
  // finishes before it turns or stops. `desired` is what the keys want now; `sent`
  // is what the server has. We hold a new `desired` until the trogg reaches the next
  // centre, then flush it. `prevX`/`prevY` are last frame's predicted position, so
  // we can spot the moment the moving axis crosses a centre between frames.
  let desired: MoveIntent = { dirX: 0, dirY: 0 };
  let sent: MoveIntent = { dirX: 0, dirY: 0 };
  let prevX = Number.NaN;
  let prevY = Number.NaN;

  const flushMove = (entry: Tracked, x: number, y: number) => {
    if (sameIntent(desired, sent)) return;
    // Start immediately when parked on a centre (idle); otherwise wait out the step.
    if (!isIdle(sent) && !reachedCentre(sent, prevX, prevY, x, y)) return;
    const at = snapToTile({ x, y });
    // Optimistic local turn so control feels instant; the server confirms with the
    // same snap (`settle` rounds to the nearest tile), so reconciliation is a no-op.
    entry.player = { ...entry.player, x: at.x, y: at.y, dirX: desired.dirX, dirY: desired.dirY };
    entry.baseMs = performance.now();
    sent = desired;
    conn.reducers.move(desired);
  };

  app.ticker.add(() => {
    const now = performance.now();
    for (const entry of tracked.values()) {
      const { x, y } = projectMotion(entry.player, now - entry.baseMs, bounds);
      place(entry.marker, x, y);
      animate(entry, now);

      if (entry.player.identity.toHexString() !== myId) continue;

      // Pushing is gated behind its flag (invariant 5); off → boulders are immovable
      // rocks, on → a trogg shoves the one it walks squarely into. We fire `push`
      // only on the transition into "facing a boulder", never per frame (invariant
      // 2); the server validates and re-bases motion, so the boulder slides at most
      // one tile per tile walked (GDD "Pushing").
      if (pushEnabled) {
        const ahead = facingTile(x, y, entry.player.dirX, entry.player.dirY);
        const facingBoulder = ahead != null && boulderTiles.has(tileKey(ahead.x, ahead.y));
        if (facingBoulder && !pushing) conn.reducers.push({});
        pushing = facingBoulder;
      }

      flushMove(entry, x, y);
      prevX = x;
      prevY = y;
    }
  });

  attachKeyboard((intent, immediate) => {
    desired = intent;
    if (!immediate) return;
    // Focus loss: stop where we are without finishing the step. A backgrounded tab's
    // ticker is frozen, so deferring would let the trogg drift to a wall before the
    // stop ever flushes.
    const me = myId ? tracked.get(myId) : undefined;
    if (me) {
      const at = snapToTile(projectMotion(me.player, performance.now() - me.baseMs, bounds));
      me.player = { ...me.player, x: at.x, y: at.y, dirX: 0, dirY: 0 };
      me.baseMs = performance.now();
    }
    sent = intent;
    conn.reducers.move(intent);
  });

  // Live once the initial rows have been delivered: backlog chat fills the
  // history panel silently, while later inserts also pop a bubble.
  const sub = { live: false };
  if (isFeatureEnabled("chat-enabled")) setupChat(conn, tracked, slug, sub, myId);

  conn
    .subscriptionBuilder()
    .onApplied(() => (sub.live = true))
    .subscribe([
      `SELECT * FROM player WHERE zone_id = '${slug}' AND online = true`,
      `SELECT * FROM chat_message WHERE zone_id = '${slug}'`,
      `SELECT * FROM boulder WHERE zone_id = '${slug}'`,
    ]);
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
  const chat = mountChat((text) => {
    conn.reducers.chat({ text });
  });

  conn.db.chatMessage.onInsert((_ctx, message) => {
    const senderId = message.sender.toHexString();
    chat.addMessage(message.name, message.text, troggColor(senderId));
    // Bubble only for fresh lines: a reconnect replays the zone's recent history,
    // and those rows can arrive after the subscription goes live — without this an
    // old message would pop a stale bubble over its sender on every refresh.
    const ageMs = Date.now() - Number(message.createdAt.microsSinceUnixEpoch / 1000n);
    if (ageMs > CHAT_BUBBLE_MS) return;
    showBubble(tracked, senderId, message.text);
    if (sub.live && senderId === myId) captureEvent("chat_sent", { zone: slug });
  });
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
  const moving = entry.player.dirX !== 0 || entry.player.dirY !== 0;
  entry.facing = facingFromDir(entry.player.dirX, entry.player.dirY, entry.facing);
  const frame = avatarFrame(moving, now);
  const key = `${entry.facing}_${frame}`;
  if (key === entry.frameKey) return; // only touch the GPU on an actual change
  entry.sprite.texture = avatarTexture("trogg", entry.facing, frame);
  entry.frameKey = key;
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

function place(marker: Container, x: number, y: number) {
  marker.position.set(x * TILE, y * TILE);
}

function centre(app: Application, stage: Container, width: number, height: number) {
  stage.position.set(
    (app.renderer.width - width * TILE) / 2,
    (app.renderer.height - height * TILE) / 2,
  );
}
