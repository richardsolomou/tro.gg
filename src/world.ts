import { Application, Container, Graphics, Sprite, Text } from "pixi.js";
import { ANCHOR, CHAT_BUBBLE_MS, facingTile, FRAME_H, FRAME_W, getZone, projectMotion, STARTING_ZONE_SLUG, troggColor, zoneBounds, type Facing } from "@trogg/shared";
import type { DbConnection } from "./module_bindings";
import type { Boulder, Hog, Player } from "./module_bindings/types";
import { attachKeyboard, type MoveIntent } from "./input.js";
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

/** How long a new direction must be held before the trogg walks rather than just
 *  turning in place — the tap-vs-hold window (GDD "Movement"). Tune for feel. */
const TURN_TAP_MS = 130;

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

/**
 * Screen-space y of a trogg's feet within its tile cell, relative to the cell's
 * top-left (where `place` anchors the marker). The feet sit at the cell's vertical
 * centre so the trogg stands in the middle of its tile, not on the bottom-edge seam.
 */
function feetY(): number {
  return TILE / 2;
}

/** Screen-space y of the top of a trogg's head, for placing labels and bubbles. */
function headTopY(): number {
  return feetY() - FRAME_H * (TILE / ART);
}

/** A boulder's live row plus its sprite. */
interface BoulderView {
  row: Boulder;
  sprite: Container;
}

/** A Hog's live row plus its sprite. */
interface HogView {
  row: Hog;
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
    for (const view of hogs.values()) {
      view.sprite.destroy({ children: true });
      view.sprite = makeHog();
      place(view.sprite, view.row.x, view.row.y);
      hogLayer.addChild(view.sprite);
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
    const id = p.identity.toHexString();
    const entry = tracked.get(id);
    if (!entry) return addPlayer(p);
    // Rebase extrapolation on every new intent so elapsed is measured in client
    // time — no server-clock sync needed, and each update reconciles drift.
    entry.player = p;
    entry.baseMs = performance.now();
    // The nameplate is baked into the marker's label at build time, so a rename
    // only shows once the marker is rebuilt from the updated row.
    if (_old.name !== p.name) rebuildMarker(id, entry);
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

  const upsertHog = (h: Hog) => {
    const key = h.id.toString();
    let view = hogs.get(key);
    if (!view) {
      view = { row: h, sprite: makeHog() };
      hogs.set(key, view);
      hogLayer.addChild(view.sprite);
    } else {
      view.row = h;
    }
    place(view.sprite, h.x, h.y);
  };
  const removeHog = (h: Hog) => {
    const view = hogs.get(h.id.toString());
    view?.sprite.destroy({ children: true });
    hogs.delete(h.id.toString());
  };

  conn.db.hog.onInsert((_ctx, h) => upsertHog(h));
  conn.db.hog.onUpdate((_ctx, _old, h) => upsertHog(h));
  conn.db.hog.onDelete((_ctx, h) => removeHog(h));

  const pushEnabled = isFeatureEnabled("boulder-pushing");

  // My-trogg movement is grid-locked (GDD "Movement", Pokémon/Zelda style): the
  // `move` reducer fires only when the trogg sits on a tile centre, so a step always
  // finishes before it turns or stops. Position stays purely server-driven (the
  // trogg moves once the server confirms the intent and pushes the row back), so
  // there's no local prediction to rewind against the confirmation — what we control
  // here is only *when* the intent is sent. `desired` is what the keys want now;
  // `sent` is the move the server has (idle = stopped); `facing` is the way the trogg
  // points (sprite only — set even while standing still). `prevX`/`prevY` are last
  // frame's predicted position, so we can spot the moving axis crossing a centre.
  let desired: MoveIntent = { dirX: 0, dirY: 0 };
  let lastDesired: MoveIntent = { dirX: 0, dirY: 0 };
  let sent: MoveIntent = { dirX: 0, dirY: 0 };
  let facing: MoveIntent = { dirX: 0, dirY: 1 };
  let prevX = Number.NaN;
  let prevY = Number.NaN;
  // A fresh press into a new direction turns the trogg in place; it only starts
  // walking if the key is still held past this beat — so a tap turns, a hold walks
  // (Pokémon-style). Gates that one hold; pressing the faced direction walks at once.
  let walkAfter = Number.POSITIVE_INFINITY;
  // Whether we were flush against a pushable boulder last frame, so `push` fires once
  // per tile (on the rising edge), not every frame.
  let pushBlocked = false;

  const startWalk = () => {
    sent = desired;
    conn.reducers.move(desired);
  };

  // Push (GDD "Pushing", behind its flag — invariant 5) fires while the trogg is
  // *walking into* a boulder: a committed direction (`sent`, not the raw key, so a
  // tap-to-turn never shoves) facing a boulder it's squarely on a centre against.
  // Edge-triggered, so holding into a boulder shoves it one tile per tile as the
  // trogg catches up (cadence falls out of walk speed); releasing at it stops you
  // flush with no shove. The server re-validates and re-bases motion (invariant 3).
  const pushStep = (x: number, y: number) => {
    const ahead = pushEnabled && !isIdle(sent) ? facingTile(x, y, sent.dirX, sent.dirY) : null;
    const intoBoulder = ahead != null && boulderTiles.has(tileKey(ahead.x, ahead.y));
    if (intoBoulder && !pushBlocked) conn.reducers.push({});
    pushBlocked = intoBoulder;
  };

  const turn = (entry: Tracked, now: number) => {
    facing = desired;
    entry.facing = facingFromDir(desired.dirX, desired.dirY, entry.facing);
    walkAfter = now + TURN_TAP_MS;
  };

  const driveSelf = (entry: Tracked, x: number, y: number, now: number) => {
    const fresh = !sameIntent(desired, lastDesired);
    lastDesired = desired;

    if (!isIdle(sent)) {
      // Walking: change direction or stop at the next tile centre (grid-lock). A new
      // direction mid-walk corners fluidly — no turn-in-place beat while moving.
      if (sameIntent(desired, sent)) return;
      if (!reachedCentre(sent, prevX, prevY, x, y)) return;
      sent = desired;
      conn.reducers.move(desired);
      if (!isIdle(desired)) facing = desired;
      return;
    }

    // Stopped (on a tile centre).
    if (isIdle(desired)) {
      walkAfter = Number.POSITIVE_INFINITY;
      return;
    }
    if (fresh) {
      // Press the way we already face → walk at once; a new direction → turn in place.
      if (sameIntent(desired, facing)) startWalk();
      else turn(entry, now);
      return;
    }
    // Holding the faced direction past the turn beat → start walking.
    if (sameIntent(desired, facing) && now >= walkAfter) {
      walkAfter = Number.POSITIVE_INFINITY;
      startWalk();
    }
  };

  app.ticker.add(() => {
    const now = performance.now();
    for (const entry of tracked.values()) {
      const { x, y } = projectMotion(entry.player, now - entry.baseMs, bounds);
      place(entry.marker, x, y);
      animate(entry, now);

      if (entry.player.identity.toHexString() !== myId) continue;

      driveSelf(entry, x, y, now);
      pushStep(x, y);
      prevX = x;
      prevY = y;
    }
  });

  attachKeyboard((intent, immediate) => {
    desired = intent;
    // Focus loss: stop now instead of finishing the step — a backgrounded tab's
    // ticker is frozen, so a buffered stop would never flush and the trogg would
    // keep sliding until it hit a wall. The server settles it onto a whole tile.
    if (immediate) {
      walkAfter = Number.POSITIVE_INFINITY;
      sent = intent;
      conn.reducers.move(intent);
    }
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
      `SELECT * FROM hog WHERE zone_id = '${slug}'`,
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

  conn.db.chatMessage.onInsert((_ctx, message) => {
    const senderId = message.sender.toHexString();
    chat.addMessage(senderId, message.name, message.text, troggColor(senderId));
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
 * the centre of the tile cell and head extending up out of it — so the
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
        .ellipse(TILE / 2, feetY(), TILE * 0.34, TILE * 0.16)
        .stroke({ width: 2, color: 0xe8dcc4 });
      marker.addChild(ring);
    }
    sprite = new Sprite(avatarTexture("trogg", facing, frame));
    // Anchor on the art's feet point (ANCHOR), not the frame's bottom edge, so the
    // feet — not the empty pixels below them — land on the tile centre.
    sprite.anchor.set(ANCHOR.x / FRAME_W, ANCHOR.y / FRAME_H);
    sprite.scale.set(TILE / ART);
    sprite.position.set(TILE / 2, feetY());
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

/**
 * A static Hog: the shared Hog sprite (GDD "Avatars"), feet centred on its tile
 * like a trogg. Spawned by the `/spawn` debug command; it has no motion, so it
 * always faces down.
 */
function makeHog(): Container {
  const sprite = new Container();
  const hog = new Sprite(avatarTexture("hog", "down", "idle"));
  hog.anchor.set(ANCHOR.x / FRAME_W, ANCHOR.y / FRAME_H);
  hog.scale.set(TILE / ART);
  hog.position.set(TILE / 2, feetY());
  sprite.addChild(hog);
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
