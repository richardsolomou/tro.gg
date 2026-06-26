import { Application, Container, FederatedPointerEvent, Graphics, Rectangle } from "pixi.js";
import { getZone, projectMotion, projectMotionState, snapToTile, STARTING_ZONE_SLUG, tileKey, timestampMs, troggColorFor, zoneBounds, type Coord, type Stamp, type Zone } from "@trogg/shared";
import type { DbConnection } from "./module_bindings";
import type { Boulder, Hog, Player } from "./module_bindings/types";
import { attachKeyboard } from "./input.js";
import { setupChat } from "./chat.js";
import { createSelfController } from "./movement.js";
import { ART, createEntities, GHOST_CHANCE, type BoulderView, type HogView, type Tracked } from "./entities.js";
import { mountHelp } from "./help.js";
import { createTerrain } from "./terrain.js";
import { facingFromDir } from "./avatars.js";
import { captureEvent, isFeatureEnabled } from "./analytics.js";
import { audio } from "./audio.js";

/** Fraction of the viewport the zone fills, leaving a rim of cave around it. */
const ZONE_FILL = 0.92;
/** Screen pixels per tile, sized to the viewport in `layout`. */
let TILE = 28;

function timestampBaseMs(movedAt: Stamp): number {
  const elapsedMs = Math.max(0, Date.now() - timestampMs(movedAt));
  return performance.now() - elapsedMs;
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
  // Avatar/scenery builders, sized off the live `TILE` (which `layout` resizes).
  const entities = createEntities(() => TILE);
  // Sprite avatars replace the placeholder marker behind an optional kill-switch;
  // the fallback is the colour marker.
  const useSprites = isFeatureEnabled("avatar-sprites");
  // Ambient roaming Hogs render behind their optional kill-switch.
  const useHogs = isFeatureEnabled("roaming-hogs");
  // Hold-shift-to-run has an optional rollout flag; off → shift is ignored and
  // movement stays at walk speed.
  const canRun = isFeatureEnabled("running");
  // The interact key (E) — pick up / put down tile-sized objects — behind its
  // optional kill-switch; off → E does nothing.
  const useInteract = isFeatureEnabled("interact");

  // Tiles boulders occupy, and tiles Hogs occupy (rebuilt each frame from their
  // projected positions — Hogs move, so their tiles shift between row updates).
  // Troggs are solid against boulders *and* Hogs (`troggBounds`); Hogs are rendered
  // against walls + boulders only (`hogBounds`), since the server already chose each
  // Hog's one-tile step clear of troggs and other Hogs (GDD "Hogs"). Troggs never
  // collide with each other, so player tiles are in neither set. The same builders
  // run server-side, so prediction confines entities to the same tiles authority does.
  const boulderTiles = new Set<string>();
  const hogTiles = new Set<string>();
  const hogBounds = zoneBounds(zone, (x, y) => boulderTiles.has(tileKey(x, y)));
  const troggBounds = zoneBounds(zone, (x, y) => boulderTiles.has(tileKey(x, y)) || hogTiles.has(tileKey(x, y)));

  const terrain = createTerrain(zone);
  const stage = new Container();
  // Background rock fills the screen behind the zone; the stage carries the floor
  // + walls + boulders + markers and is centred; the vignette darkens edges on top.
  app.stage.addChild(terrain.background, stage, terrain.vignette);
  stage.addChild(terrain.ground);
  const destinationLayer = new Container();
  const boulderLayer = new Container();
  const hogLayer = new Container();
  const clickLayer = new Graphics();
  clickLayer.eventMode = "static";
  stage.addChild(destinationLayer, boulderLayer, hogLayer, clickLayer);

  const tracked = new Map<string, Tracked>();
  const boulders = new Map<string, BoulderView>();
  const hogs = new Map<string, HogView>();
  // The click-to-move marker the controller asks us to show; display-only (the controller
  // owns the routing target it derives this from).
  let destinationTile: Coord | undefined;
  // Subscription bootstrap guard. Row handlers can receive the initial snapshot;
  // sounds should only fire for live gameplay diffs after that snapshot is applied.
  const sub = { live: false };

  const drawDestination = () => {
    destinationLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
    if (!destinationTile) return;
    const px = Math.max(1, Math.round(TILE / ART));
    const inset = Math.max(2, Math.round(TILE * 0.1));
    const marker = new Graphics()
      .rect(inset, inset, TILE - inset * 2, TILE - inset * 2)
      .fill(0xe8dcc4)
      .rect(inset, inset, TILE - inset * 2, TILE - inset * 2)
      .stroke({ width: px * 2, color: 0xf2c94c, alignment: 0 });
    marker.alpha = 0.28;
    entities.place(marker, destinationTile.x, destinationTile.y);
    destinationLayer.addChild(marker);
  };

  // The local player's prediction + input state machine. It owns all prediction state;
  // we feed it the per-frame projected motion (`update`) and server rows (`reconcile`),
  // and wire input to `onIntent`/`onClick`. The collision sets are passed live — the
  // controller reads whatever the ticker last put in them.
  const self = createSelfController({
    conn,
    bounds: troggBounds,
    hogTiles,
    boulderTiles,
    pushEnabled: isFeatureEnabled("boulder-pushing"),
    getSelf: () => (myId ? tracked.get(myId) : undefined),
    showDestination: (tile) => {
      destinationTile = tile;
      drawDestination();
    },
    toBaseMs: timestampBaseMs,
    facingFromDir,
    audio,
  });

  const layout = () => {
    const { width: vw, height: vh } = app.renderer;
    const fit = Math.min((vw * ZONE_FILL) / zone.width, (vh * ZONE_FILL) / zone.height);
    TILE = Math.max(ART, Math.floor(fit));
    terrain.layout(TILE, vw, vh);
    clickLayer.clear();
    clickLayer.hitArea = new Rectangle(0, 0, zone.width * TILE, zone.height * TILE);
    drawDestination();
    entities.centre(app, stage, zone.width, zone.height);
    // Markers and boulder sprites bake TILE into their size, so resize redraws them.
    for (const [id, entry] of tracked) rebuildMarker(id, entry);
    for (const view of boulders.values()) {
      view.sprite.destroy({ children: true });
      view.sprite = entities.makeBoulder();
      entities.place(view.sprite, view.row.x, view.row.y);
      boulderLayer.addChild(view.sprite);
    }
    // Hog sprites bake TILE into their scale too; the ticker repositions them next frame.
    for (const view of hogs.values()) {
      view.marker.destroy({ children: true });
      const built = entities.makeHog(view.facing);
      view.marker = built.marker;
      view.sprite = built.sprite;
      view.frameKey = built.frameKey;
      entities.place(view.marker, view.row.x, view.row.y);
      hogLayer.addChild(view.marker);
    }
  };

  const rebuildMarker = (id: string, entry: Tracked) => {
    if (entry.bubbleTimer) clearTimeout(entry.bubbleTimer);
    entry.marker.destroy({ children: true });
    const built = entities.makeMarker(entry.player.name, troggColorFor(entry.player.color, id), id === myId, entry.facing, useSprites);
    entry.marker = built.marker;
    entry.sprite = built.sprite;
    entry.frameKey = built.frameKey;
    entry.bubble = undefined;
    entry.bubbleTimer = undefined;
    // The carried overlay was a child of the old marker, so it's gone too; re-add it.
    entry.carried = undefined;
    entry.carriedKind = "";
    const { x, y } = projectMotion(entry.player, performance.now() - entry.baseMs, troggBounds);
    entities.place(entry.marker, x, y);
    stage.addChild(entry.marker);
    entities.applyCarry(entry);
  };

  app.renderer.on("resize", layout);
  layout();

  const addPlayer = (p: Player) => {
    const id = p.identity.toHexString();
    if (tracked.has(id)) return;
    const facing = facingFromDir(p.dirX, p.dirY, "down");
    const { marker, sprite, frameKey } = entities.makeMarker(p.name, troggColorFor(p.color, id), id === myId, facing, useSprites);
    const entry: Tracked = { marker, sprite, player: p, baseMs: timestampBaseMs(p.movedAt), facing, frameKey, carriedKind: "" };
    const { x, y } = projectMotion(p, performance.now() - entry.baseMs, troggBounds);
    entities.place(marker, x, y);
    tracked.set(id, entry);
    stage.addChild(marker);
    entities.applyCarry(entry);
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

    if (id === myId) {
      self.reconcile(entry, p);
    } else {
      // Rebase extrapolation to the server's `movedAt` on the local monotonic clock,
      // not receipt time, so a deployed client doesn't trail the server by its network
      // latency (which would show as correction jitter).
      entry.player = p;
      entry.baseMs = timestampBaseMs(p.movedAt);
    }

    // The nameplate and tint are baked into the marker at build time, so a rename
    // or recolour only shows once the marker is rebuilt from the updated row (which
    // also re-applies the carried overlay). A bare carrying change just retargets
    // the overlay.
    if (_old.name !== p.name || _old.color !== p.color) rebuildMarker(id, entry);
    else if (_old.carrying !== p.carrying) entities.applyCarry(entry);

    // Pick-up / put-down are low-volume, so emit on the authoritative carrying
    // transition of your own trogg (GDD analytics: observe server truth).
    if (id === myId && _old.carrying !== p.carrying) {
      captureEvent(p.carrying ? "object_picked_up" : "object_dropped", { zone: slug, kind: p.carrying || _old.carrying });
    }
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
      view = { row: b, sprite: entities.makeBoulder() };
      boulders.set(key, view);
      boulderLayer.addChild(view.sprite);
    } else {
      view.row = b;
    }
    entities.place(view.sprite, b.x, b.y);
    syncBoulderTiles();
  };
  const removeBoulder = (b: Boulder) => {
    const view = boulders.get(b.id.toString());
    view?.sprite.destroy({ children: true });
    boulders.delete(b.id.toString());
    syncBoulderTiles();
  };

  conn.db.boulder.onInsert((_ctx, b) => upsertBoulder(b));
  conn.db.boulder.onUpdate((_ctx, _old, b) => {
    if (sub.live && (_old.x !== b.x || _old.y !== b.y)) audio.playBoulderSettle();
    upsertBoulder(b);
  });
  conn.db.boulder.onDelete((_ctx, b) => removeBoulder(b));

  const addHog = (h: Hog) => {
    const id = h.id.toString();
    if (hogs.has(id)) return;
    const facing = facingFromDir(h.dirX, h.dirY, "down");
    const { marker, sprite, frameKey } = entities.makeHog(facing);
    const baseMs = timestampBaseMs(h.movedAt);
    const { x, y } = projectMotion(h, performance.now() - baseMs, hogBounds);
    entities.place(marker, x, y);
    hogs.set(id, { marker, sprite, row: h, baseMs, facing, frameKey });
    hogLayer.addChild(marker);
  };
  const updateHog = (h: Hog) => {
    const view = hogs.get(h.id.toString());
    if (!view) return addHog(h);
    // Rebase extrapolation on each new intent, like remote players.
    view.row = h;
    view.baseMs = timestampBaseMs(h.movedAt);
  };
  const removeHog = (h: Hog) => {
    const view = hogs.get(h.id.toString());
    view?.marker.destroy({ children: true });
    hogs.delete(h.id.toString());
  };

  // Roaming Hogs render behind their optional kill-switch.
  if (useHogs) {
    conn.db.hog.onInsert((_ctx, h) => addHog(h));
    conn.db.hog.onUpdate((_ctx, _old, h) => {
      updateHog(h);
      if (!sub.live) return;
      const changedHeading = _old.dirX !== h.dirX || _old.dirY !== h.dirY;
      if (changedHeading && Math.random() < 0.35) audio.playHog();
    });
    conn.db.hog.onDelete((_ctx, h) => removeHog(h));
  }

  app.ticker.add(() => {
    const now = performance.now();

    // Hogs first: derive each Hog's position (intent extrapolation, never per-frame
    // sync — invariant 2) and rebuild the Hog tile set so trogg collision this frame
    // sees where the Hogs actually are. Hogs collide against walls and boulders only;
    // the server already kept their one-tile step clear of troggs and other Hogs.
    hogTiles.clear();
    for (const view of hogs.values()) {
      const motion = projectMotionState(view.row, now - view.baseMs, hogBounds);
      entities.place(view.marker, motion.x, motion.y);
      entities.driveSprite(view.sprite, "hog", motion.dirX, motion.dirY, false, view, now);
      const tile = snapToTile({ x: motion.x, y: motion.y });
      hogTiles.add(tileKey(tile.x, tile.y));
    }

    for (const entry of tracked.values()) {
      const motion = projectMotionState(entry.player, now - entry.baseMs, troggBounds);
      const { x, y } = motion;
      entities.place(entry.marker, x, y);
      entities.animate(entry, now, motion);

      if (entry.player.identity.toHexString() !== myId) continue;
      self.update(entry, motion, now);
    }
  });

  attachKeyboard((intent, immediate) => self.onIntent(intent, immediate), () => {
    // Interact with the faced tile (GDD "Interacting"): pick up / put down. The
    // server has no synced standing facing, so pass the trogg's current heading;
    // it re-derives the tile and acts only on what's actually adjacent (invariant 3).
    if (!useInteract) return;
    conn.reducers.interact({ dirX: self.facing.dirX, dirY: self.facing.dirY });
  }, canRun);

  clickLayer.on("pointertap", (e: FederatedPointerEvent) => {
    const local = e.getLocalPosition(stage);
    const x = Math.floor(local.x / TILE);
    const y = Math.floor(local.y / TILE);
    if (x < 0 || y < 0 || x >= zone.width || y >= zone.height) return;
    self.onClick({ x, y });
  });

  // Cosmetic join easter egg. Each launch has a chance of a haunt at the origin.
  if (isFeatureEnabled("ghost-trogg") && Math.random() < GHOST_CHANCE) entities.hauntGhost(stage, { x: 0, y: 0 });

  // Live once the initial rows have been delivered: backlog chat fills the
  // history panel silently, while later inserts also pop a bubble.
  if (isFeatureEnabled("chat-enabled")) setupChat(app, conn, entities, tracked, zone, sub, myId, stage);

  // A standing reference of controls and chat commands so a fresh trogg knows what
  // it can do — listing only the features this session has enabled (GDD HUD note).
  mountHelp(app);

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

