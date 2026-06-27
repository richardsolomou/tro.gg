import Phaser from "phaser";
import { getZone, projectMotion, projectMotionState, snapToTile, STARTING_ZONE_SLUG, tileKey, timestampMs, troggColorFor, zoneBounds, type Coord, type Stamp, type ZoneBounds } from "@trogg/shared";
import type { DbConnection } from "../../net/module_bindings";
import type { Boulder, Hog, Player } from "../../net/module_bindings/types";
import { attachKeyboard } from "../../input.js";
import { setupChat } from "../../ui/chat.js";
import { createSelfController, type SelfController } from "../../movement.js";
import { ART, createEntities, GHOST_CHANCE, type BoulderView, type Entities, type HogView, type Tracked } from "../entities.js";
import { createTerrain, registerTerrainTextures, type Terrain } from "../terrain.js";
import { facingFromDir, registerAvatarTextures } from "../avatars.js";
import { captureEvent, isFeatureEnabled } from "../../analytics.js";
import { audio } from "../../audio.js";

/** Fraction of the viewport the zone fills, leaving a rim of cave around it. */
const ZONE_FILL = 0.92;

function timestampBaseMs(movedAt: Stamp): number {
  const elapsedMs = Math.max(0, Date.now() - timestampMs(movedAt));
  return performance.now() - elapsedMs;
}

/** What the bootstrap (main.ts) hands the scene once the connection is live. */
export interface WorldSceneData {
  conn: DbConnection;
}

/**
 * The game scene. Renders the zone — a tile grid plus a marker per player — and
 * runs the per-frame extrapolation loop in `update`. Movement is intent-based (GDD
 * "Movement"): the `player` table syncs each trogg's origin, direction, and start
 * time, and every client extrapolates position locally each frame so motion is
 * smooth without per-frame server sync (invariant 2). Zone dimensions come from the
 * static `ZONES` registry (shared by client and module). Phaser is the renderer per
 * the GDD "Camera and rendering" section; all authority stays server-side.
 */
export class WorldScene extends Phaser.Scene {
  private conn!: DbConnection;

  private readonly slug = STARTING_ZONE_SLUG;
  private readonly zone = getZone(STARTING_ZONE_SLUG)!;
  /** Screen pixels per tile, sized to the viewport in `layout`. */
  private tile = 28;
  private myId?: string;

  private entities!: Entities;
  private terrain!: Terrain;
  private stage!: Phaser.GameObjects.Container;
  private destinationLayer!: Phaser.GameObjects.Container;
  private boulderLayer!: Phaser.GameObjects.Container;
  private hogLayer!: Phaser.GameObjects.Container;
  private clickZone!: Phaser.GameObjects.Zone;
  private self!: SelfController;

  private readonly tracked = new Map<string, Tracked>();
  private readonly boulders = new Map<string, BoulderView>();
  private readonly hogs = new Map<string, HogView>();

  // Tiles boulders occupy, and tiles Hogs occupy (rebuilt each frame from their
  // projected positions — Hogs move, so their tiles shift between row updates).
  // Troggs are solid against boulders *and* Hogs (`troggBounds`); Hogs are confined
  // to walls + boulders only (`hogBounds`), since the server already chose each Hog's
  // one-tile step clear of troggs and other Hogs (GDD "Hogs"). Troggs never collide
  // with each other, so player tiles are in neither set. The same builders run
  // server-side, so prediction confines entities to the same tiles authority does.
  private readonly boulderTiles = new Set<string>();
  private readonly hogTiles = new Set<string>();
  private hogBounds!: ZoneBounds;
  private troggBounds!: ZoneBounds;

  /** The click-to-move marker to show; display-only (the controller owns the target). */
  private destinationTile?: Coord;
  // Subscription bootstrap guard. Row handlers can receive the initial snapshot;
  // sounds should only fire for live gameplay diffs after that snapshot is applied.
  private readonly sub = { live: false };

  private useSprites = false;
  private useHogs = false;
  private canRun = false;
  private useInteract = false;

  constructor() {
    super("world");
  }

  init(data: WorldSceneData) {
    this.conn = data.conn;
  }

  // Textures are painted from code (no asset files), but registering them up front
  // keeps the gameplay scene's `create` to building the world, not preparing pixels.
  preload() {
    registerAvatarTextures(this);
    registerTerrainTextures(this);
  }

  create() {
    const conn = this.conn;
    this.myId = conn.identity?.toHexString();
    this.entities = createEntities(this, () => this.tile);
    // Optional kill-switches: sprite avatars (else the placeholder colour marker),
    // ambient roaming Hogs, hold-shift-to-run, and the interact key.
    this.useSprites = isFeatureEnabled("avatar-sprites");
    this.useHogs = isFeatureEnabled("roaming-hogs");
    this.canRun = isFeatureEnabled("running");
    this.useInteract = isFeatureEnabled("interact");

    // The collision sets are read live by these bounds and by the controller, so the
    // per-frame tick only has to refill the sets, never rewire anything.
    this.hogBounds = zoneBounds(this.zone, (x, y) => this.boulderTiles.has(tileKey(x, y)));
    this.troggBounds = zoneBounds(this.zone, (x, y) => this.boulderTiles.has(tileKey(x, y)) || this.hogTiles.has(tileKey(x, y)));

    this.terrain = createTerrain(this, this.zone);
    // Background rock fills the screen behind the zone; the stage carries the floor
    // + walls + boulders + markers and is centred; the vignette darkens edges on top.
    this.stage = this.add.container(0, 0);
    this.terrain.background.setDepth(0);
    this.stage.setDepth(1);
    this.terrain.vignette.setDepth(2);
    this.stage.add(this.terrain.ground);

    this.destinationLayer = this.add.container(0, 0);
    this.boulderLayer = this.add.container(0, 0);
    this.hogLayer = this.add.container(0, 0);
    this.stage.add([this.destinationLayer, this.boulderLayer, this.hogLayer]);

    // An invisible interactive zone over the play field captures click-to-move. HUD
    // panels consume their own clicks (pointer-events), so only open-space clicks reach it.
    this.clickZone = this.add.zone(0, 0, 1, 1).setOrigin(0, 0).setInteractive();
    this.clickZone.setDepth(1);

    // The local player's prediction + input state machine. It owns all prediction
    // state; we feed it the per-frame projected motion (`update`) and server rows
    // (`reconcile`), and wire input to `onIntent`/`onClick`.
    this.self = createSelfController({
      conn,
      bounds: this.troggBounds,
      hogTiles: this.hogTiles,
      boulderTiles: this.boulderTiles,
      pushEnabled: isFeatureEnabled("boulder-pushing"),
      getSelf: () => (this.myId ? this.tracked.get(this.myId) : undefined),
      showDestination: (tile) => {
        this.destinationTile = tile;
        this.drawDestination();
      },
      toBaseMs: timestampBaseMs,
      facingFromDir,
      audio,
    });

    this.wirePlayers();
    this.wireBoulders();
    if (this.useHogs) this.wireHogs();

    attachKeyboard(
      (intent, immediate) => this.self.onIntent(intent, immediate),
      () => {
        // Interact with the faced tile (GDD "Interacting"): pick up / put down. The
        // server has no synced standing facing, so pass the trogg's current heading;
        // it re-derives the tile and acts only on what's actually adjacent (invariant 3).
        if (!this.useInteract) return;
        conn.reducers.interact({ dirX: this.self.facing.dirX, dirY: this.self.facing.dirY });
      },
      this.canRun,
    );

    this.clickZone.on("pointerdown", (_pointer: Phaser.Input.Pointer, localX: number, localY: number) => {
      const x = Math.floor(localX / this.tile);
      const y = Math.floor(localY / this.tile);
      if (x < 0 || y < 0 || x >= this.zone.width || y >= this.zone.height) return;
      this.self.onClick({ x, y });
    });

    this.scale.on(Phaser.Scale.Events.RESIZE, this.layout, this);
    this.layout();

    // Cosmetic join easter egg. Each launch has a chance of a haunt at the origin.
    if (isFeatureEnabled("ghost-trogg") && Math.random() < GHOST_CHANCE) this.entities.hauntGhost(this.stage, { x: 0, y: 0 });

    // Live once the initial rows have been delivered: backlog chat fills the
    // history panel silently, while later inserts also pop a bubble.
    if (isFeatureEnabled("chat-enabled")) setupChat(conn, this.entities, this.tracked, this.zone, this.sub, this.myId, this.stage);

    const queries = [
      `SELECT * FROM player WHERE zone_id = '${this.slug}' AND online = true`,
      `SELECT * FROM chat_message WHERE zone_id = '${this.slug}'`,
      `SELECT * FROM boulder WHERE zone_id = '${this.slug}'`,
    ];
    if (this.useHogs) queries.push(`SELECT * FROM hog WHERE zone_id = '${this.slug}'`);

    conn
      .subscriptionBuilder()
      .onApplied(() => (this.sub.live = true))
      .subscribe(queries);
  }

  /** Per-frame extrapolation (Phaser calls this each tick). Positions are projected
   *  locally from each row's intent — never per-frame synced (invariant 2). */
  update() {
    const now = performance.now();

    // Hogs first: derive each Hog's position and rebuild the Hog tile set so trogg
    // collision this frame sees where the Hogs actually are. Hogs collide against
    // walls and boulders only; the server kept their step clear of troggs and Hogs.
    this.hogTiles.clear();
    for (const view of this.hogs.values()) {
      const motion = projectMotionState(view.row, now - view.baseMs, this.hogBounds);
      this.entities.place(view.marker, motion.x, motion.y);
      this.entities.driveSprite(view.sprite, "hog", motion.dirX, motion.dirY, false, view, now);
      const tile = snapToTile({ x: motion.x, y: motion.y });
      this.hogTiles.add(tileKey(tile.x, tile.y));
    }

    for (const entry of this.tracked.values()) {
      const motion = projectMotionState(entry.player, now - entry.baseMs, this.troggBounds);
      this.entities.place(entry.marker, motion.x, motion.y);
      this.entities.animate(entry, now, motion);

      if (entry.player.identity.toHexString() !== this.myId) continue;
      this.self.update(entry, motion, now);
    }
  }

  private drawDestination() {
    this.destinationLayer.removeAll(true);
    if (!this.destinationTile) return;
    const px = Math.max(1, Math.round(this.tile / ART));
    const inset = Math.max(2, Math.round(this.tile * 0.1));
    const marker = this.add.graphics();
    marker.fillStyle(0xe8dcc4, 1).fillRect(inset, inset, this.tile - inset * 2, this.tile - inset * 2);
    marker.lineStyle(px * 2, 0xf2c94c, 1).strokeRect(inset, inset, this.tile - inset * 2, this.tile - inset * 2);
    marker.setAlpha(0.28);
    this.entities.place(marker, this.destinationTile.x, this.destinationTile.y);
    this.destinationLayer.add(marker);
  }

  private layout() {
    const vw = this.scale.width;
    const vh = this.scale.height;
    const fit = Math.min((vw * ZONE_FILL) / this.zone.width, (vh * ZONE_FILL) / this.zone.height);
    this.tile = Math.max(ART, Math.floor(fit));
    this.terrain.layout(this.tile, vw, vh);
    this.entities.centre(this.stage, vw, vh, this.zone.width, this.zone.height);
    // The click zone shadows the zone in screen space (stage is centred, not scrolled).
    this.clickZone.setPosition(this.stage.x, this.stage.y);
    this.clickZone.setSize(this.zone.width * this.tile, this.zone.height * this.tile);
    this.drawDestination();
    // Markers and boulder sprites bake the tile size into their geometry, so a resize
    // redraws them; the tick repositions them next frame.
    for (const [id, entry] of this.tracked) this.rebuildMarker(id, entry);
    for (const view of this.boulders.values()) {
      view.sprite.destroy();
      view.sprite = this.entities.makeBoulder();
      this.entities.place(view.sprite, view.row.x, view.row.y);
      this.boulderLayer.add(view.sprite);
    }
    for (const view of this.hogs.values()) {
      view.marker.destroy();
      const built = this.entities.makeHog(view.facing);
      view.marker = built.marker;
      view.sprite = built.sprite;
      view.frameKey = built.frameKey;
      this.entities.place(view.marker, view.row.x, view.row.y);
      this.hogLayer.add(view.marker);
    }
  }

  private rebuildMarker(id: string, entry: Tracked) {
    if (entry.bubbleTimer) clearTimeout(entry.bubbleTimer);
    entry.marker.destroy();
    const built = this.entities.makeMarker(entry.player.name, troggColorFor(entry.player.color, id), id === this.myId, entry.facing, this.useSprites);
    entry.marker = built.marker;
    entry.sprite = built.sprite;
    entry.frameKey = built.frameKey;
    entry.bubble = undefined;
    entry.bubbleTimer = undefined;
    // The carried overlay was a child of the old marker, so it's gone too; re-add it.
    entry.carried = undefined;
    entry.carriedKind = "";
    const { x, y } = projectMotion(entry.player, performance.now() - entry.baseMs, this.troggBounds);
    this.entities.place(entry.marker, x, y);
    this.stage.add(entry.marker);
    this.entities.applyCarry(entry);
  }

  private wirePlayers() {
    const conn = this.conn;
    conn.db.player.onInsert((_ctx, p) => this.addPlayer(p));
    conn.db.player.onUpdate((_ctx, _old, p) => {
      const id = p.identity.toHexString();
      const entry = this.tracked.get(id);
      if (!entry) return this.addPlayer(p);

      if (id === this.myId) {
        this.self.reconcile(entry, p);
      } else {
        // Rebase extrapolation to the server's `movedAt` on the local monotonic clock,
        // not receipt time, so a deployed client doesn't trail the server by its network
        // latency (which would show as correction jitter).
        entry.player = p;
        entry.baseMs = timestampBaseMs(p.movedAt);
      }

      // The nameplate and tint are baked into the marker at build time, so a rename or
      // recolour only shows once the marker is rebuilt (which re-applies the carried
      // overlay). A bare carrying change just retargets the overlay.
      if (_old.name !== p.name || _old.color !== p.color) this.rebuildMarker(id, entry);
      else if (_old.carrying !== p.carrying) this.entities.applyCarry(entry);

      // Pick-up / put-down are low-volume, so emit on the authoritative carrying
      // transition of your own trogg (GDD analytics: observe server truth).
      if (id === this.myId && _old.carrying !== p.carrying) {
        captureEvent(p.carrying ? "object_picked_up" : "object_dropped", { zone: this.slug, kind: p.carrying || _old.carrying });
      }
    });
    conn.db.player.onDelete((_ctx, p) => this.removePlayer(p.identity.toHexString()));
  }

  private addPlayer(p: Player) {
    const id = p.identity.toHexString();
    if (this.tracked.has(id)) return;
    const facing = facingFromDir(p.dirX, p.dirY, "down");
    const { marker, sprite, frameKey } = this.entities.makeMarker(p.name, troggColorFor(p.color, id), id === this.myId, facing, this.useSprites);
    const entry: Tracked = { marker, sprite, player: p, baseMs: timestampBaseMs(p.movedAt), facing, frameKey, carriedKind: "" };
    const { x, y } = projectMotion(p, performance.now() - entry.baseMs, this.troggBounds);
    this.entities.place(marker, x, y);
    this.tracked.set(id, entry);
    this.stage.add(marker);
    this.entities.applyCarry(entry);
  }

  private removePlayer(id: string) {
    const entry = this.tracked.get(id);
    if (entry?.bubbleTimer) clearTimeout(entry.bubbleTimer);
    entry?.marker.destroy();
    this.tracked.delete(id);
  }

  private syncBoulderTiles() {
    this.boulderTiles.clear();
    for (const view of this.boulders.values()) this.boulderTiles.add(tileKey(view.row.x, view.row.y));
  }

  private upsertBoulder(b: Boulder) {
    const key = b.id.toString();
    let view = this.boulders.get(key);
    if (!view) {
      view = { row: b, sprite: this.entities.makeBoulder() };
      this.boulders.set(key, view);
      this.boulderLayer.add(view.sprite);
    } else {
      view.row = b;
    }
    this.entities.place(view.sprite, b.x, b.y);
    this.syncBoulderTiles();
  }

  private removeBoulder(b: Boulder) {
    const view = this.boulders.get(b.id.toString());
    view?.sprite.destroy();
    this.boulders.delete(b.id.toString());
    this.syncBoulderTiles();
  }

  private wireBoulders() {
    const conn = this.conn;
    conn.db.boulder.onInsert((_ctx, b) => this.upsertBoulder(b));
    conn.db.boulder.onUpdate((_ctx, _old, b) => {
      if (this.sub.live && (_old.x !== b.x || _old.y !== b.y)) audio.playBoulderSettle();
      this.upsertBoulder(b);
    });
    conn.db.boulder.onDelete((_ctx, b) => this.removeBoulder(b));
  }

  private addHog(h: Hog) {
    const id = h.id.toString();
    if (this.hogs.has(id)) return;
    const facing = facingFromDir(h.dirX, h.dirY, "down");
    const { marker, sprite, frameKey } = this.entities.makeHog(facing);
    const baseMs = timestampBaseMs(h.movedAt);
    const { x, y } = projectMotion(h, performance.now() - baseMs, this.hogBounds);
    this.entities.place(marker, x, y);
    this.hogs.set(id, { marker, sprite, row: h, baseMs, facing, frameKey });
    this.hogLayer.add(marker);
  }

  private updateHog(h: Hog) {
    const view = this.hogs.get(h.id.toString());
    if (!view) return this.addHog(h);
    // Rebase extrapolation on each new intent, like remote players.
    view.row = h;
    view.baseMs = timestampBaseMs(h.movedAt);
  }

  private removeHog(h: Hog) {
    const view = this.hogs.get(h.id.toString());
    view?.marker.destroy();
    this.hogs.delete(h.id.toString());
  }

  private wireHogs() {
    const conn = this.conn;
    conn.db.hog.onInsert((_ctx, h) => this.addHog(h));
    conn.db.hog.onUpdate((_ctx, _old, h) => {
      this.updateHog(h);
      if (!this.sub.live) return;
      const changedHeading = _old.dirX !== h.dirX || _old.dirY !== h.dirY;
      if (changedHeading && Math.random() < 0.35) audio.playHog();
    });
    conn.db.hog.onDelete((_ctx, h) => this.removeHog(h));
  }
}
