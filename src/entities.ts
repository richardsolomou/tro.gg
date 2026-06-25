import { Application, Container, Graphics, Sprite, Text } from "pixi.js";
import { ANCHOR, FRAME_H, FRAME_W, type Facing, type Kind, type ProjectedMotion } from "@trogg/shared";
import type { Boulder, Hog, Player } from "./module_bindings/types";
import { avatarFrame, avatarTexture, facingFromDir, ghostTexture } from "./avatars.js";
import { TEXT_RESOLUTION } from "./ui_text.js";
import { audio } from "./audio.js";

/** Art pixels per tile — terrain tiles are drawn at this and scaled up crisply. */
export const ART = 16;
/** Size of a carried object's overlay relative to a full tile (GDD "Interacting"). */
const CARRY_SCALE = 0.62;
/** Odds a given launch is haunted by the ghost trogg. */
export const GHOST_CHANCE = 1 / 20;
/** How long the apparition holds before it fades. */
const GHOST_FLICKER_MS = 500;

/** A player's sprite plus the client-clock instant its current intent arrived. */
export interface Tracked {
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
  /** The overlay sprite for what the trogg carries (GDD "Interacting"), if any. */
  carried?: Container;
  /** Which kind the overlay shows ("" = none), so it only rebuilds on change. */
  carriedKind: string;
}

/** A boulder's live row plus its sprite. */
export interface BoulderView {
  row: Boulder;
  sprite: Container;
}

/** A roaming Hog's sprite plus the client-clock instant its current intent arrived. */
export interface HogView {
  marker: Container;
  sprite: Sprite;
  row: Hog;
  baseMs: number;
  facing: Facing;
  frameKey: string;
}

/**
 * Avatar/scenery builders and tile-space placement, all sized off the live `TILE`
 * metric (`getTile`, which the world resizes in its layout). They build PixiJS display
 * objects from game state — no netcode or prediction — so the world and chat layers
 * share one rig. `feetY`/`headTopY` give the in-cell anchor points labels and bubbles
 * hang off of.
 */
export function createEntities(getTile: () => number) {
  /**
   * Screen-space y of a trogg's feet within its tile cell, relative to the cell's
   * top-left (where `place` anchors the marker). The feet sit at the cell's vertical
   * centre so the trogg stands in the middle of its tile, not on the bottom-edge seam.
   */
  const feetY = () => getTile() / 2;

  /** Screen-space y of the top of a trogg's head, for placing labels and bubbles. */
  const headTopY = () => feetY() - FRAME_H * (getTile() / ART);

  const place = (marker: Container, x: number, y: number) => {
    const tile = getTile();
    marker.position.set(x * tile, y * tile);
  };

  const centre = (app: Application, stage: Container, width: number, height: number) => {
    const tile = getTile();
    stage.position.set((app.renderer.width - width * tile) / 2, (app.renderer.height - height * tile) / 2);
  };

  /**
   * A trogg. With the `avatar-sprites` flag on, it's the layered avatar sprite
   * (GDD "Avatars and equipment") tinted by the player's stable colour, feet at
   * the centre of the tile cell and head extending up out of it — so the
   * per-player colour, formerly the whole marker, now rides as a tint, keeping
   * "the same trogg is the same colour for everyone". With the flag off it's the
   * placeholder colour marker (a tile-filling rect). Both carry a name label.
   */
  const makeMarker = (name: string, color: number, self: boolean, facing: Facing, sprites: boolean) => {
    const tile = getTile();
    const marker = new Container();
    let sprite: Sprite | undefined;
    let frameKey = "";

    if (sprites) {
      const frame = avatarFrame(false, false, 0);
      // Self gets a bright ground ring under the feet so you can pick yourself out.
      if (self) {
        const ring = new Graphics().ellipse(tile / 2, feetY(), tile * 0.34, tile * 0.16).stroke({ width: 2, color: 0xe8dcc4 });
        marker.addChild(ring);
      }
      sprite = new Sprite(avatarTexture("trogg", facing, frame));
      // Anchor on the art's feet point (ANCHOR), not the frame's bottom edge, so the
      // feet — not the empty pixels below them — land on the tile centre.
      sprite.anchor.set(ANCHOR.x / FRAME_W, ANCHOR.y / FRAME_H);
      sprite.scale.set(tile / ART);
      sprite.position.set(tile / 2, feetY());
      sprite.tint = color;
      marker.addChild(sprite);
      frameKey = `${facing}_${frame}`;
    } else {
      const body = new Graphics().rect(2, 2, tile - 4, tile - 4).fill(color);
      // Your own trogg keeps its colour but gets an outline so you can pick it out.
      if (self) body.rect(2, 2, tile - 4, tile - 4).stroke({ width: 2, color: 0xe8dcc4 });
      marker.addChild(body);
    }

    const label = new Text({
      text: name,
      style: { fontFamily: "monospace", fontSize: 11, fill: 0xe8dcc4 },
      resolution: TEXT_RESOLUTION,
    });
    label.anchor.set(0.5, 1);
    label.position.set(tile / 2, sprites ? headTopY() - 2 : -2);
    marker.addChild(label);

    return { marker, sprite, frameKey };
  };

  /** Drive a trogg's facing and walk cycle from its synced motion intent. No-op
   *  for the placeholder marker (no sprite to swap). */
  const animate = (entry: Tracked, now: number, motion: ProjectedMotion) => {
    if (!entry.sprite) return;
    driveSprite(entry.sprite, "trogg", motion.dirX, motion.dirY, entry.player.running, entry, now);
  };

  /**
   * Point a sprite's facing and stride frame at its motion intent, mutating the
   * caller's `facing`/`frameKey` so the next frame compares against it. Shared by
   * troggs and Hogs (one rig); `running` picks the faster hunched run cycle (troggs
   * only — Hogs always walk). Only touches the GPU when the frame actually changes.
   */
  const driveSprite = (
    sprite: Sprite,
    kind: Kind,
    dirX: number,
    dirY: number,
    running: boolean,
    state: { facing: Facing; frameKey: string },
    now: number,
  ) => {
    const moving = dirX !== 0 || dirY !== 0;
    state.facing = facingFromDir(dirX, dirY, state.facing);
    const frame = avatarFrame(moving, running, now);
    const key = `${state.facing}_${frame}`;
    if (key === state.frameKey) return;
    sprite.texture = avatarTexture(kind, state.facing, frame);
    state.frameKey = key;
  };

  /** A pushable boulder: a rounded stone filling its tile, with a lit top-left face. */
  const makeBoulder = () => {
    const tile = getTile();
    const sprite = new Container();
    const inset = Math.max(2, Math.round(tile * 0.1));
    const size = tile - inset * 2;
    const radius = Math.max(3, Math.round(tile * 0.28));
    const px = Math.max(1, Math.round(tile / ART));
    const body = new Graphics()
      .roundRect(inset, inset, size, size, radius)
      .fill(0x6b5640)
      .stroke({ width: px, color: 0x2a2118, alignment: 0 });
    // A small highlight reads as a lit facet under the cave's torchlight.
    body.roundRect(inset + px, inset + px, size * 0.4, size * 0.4, radius * 0.6).fill(0x8a7257);
    sprite.addChild(body);
    return sprite;
  };

  /**
   * The overlay for what a trogg carries (GDD "Interacting"): the held object drawn
   * small, on the trogg's person above its head — a boulder, a hog, and (later) any
   * tile-sized thing all read the same held way. `topY` is the head top in sprite
   * mode, the cell top for the placeholder marker. Unknown kind → no overlay.
   */
  const makeCarried = (kind: string, topY: number): Container | undefined => {
    const tile = getTile();
    const wrap = new Container();
    if (kind === "boulder") {
      const b = makeBoulder();
      b.pivot.set(tile / 2, tile / 2);
      b.scale.set(CARRY_SCALE);
      wrap.addChild(b);
    } else if (kind === "hog") {
      const sprite = new Sprite(avatarTexture("hog", "down", "idle"));
      sprite.anchor.set(0.5, 0.85);
      sprite.scale.set((tile / ART) * CARRY_SCALE);
      wrap.addChild(sprite);
    } else {
      return undefined;
    }
    wrap.position.set(tile / 2, topY - 2);
    return wrap;
  };

  /** Sync a trogg's carried overlay to its `carrying` kind, rebuilding only on change. */
  const applyCarry = (entry: Tracked): void => {
    const kind = entry.player.carrying;
    if (kind === entry.carriedKind) return;
    entry.carried?.destroy({ children: true });
    entry.carried = undefined;
    entry.carriedKind = "";
    const overlay = makeCarried(kind, entry.sprite ? headTopY() : 0);
    if (overlay) {
      entry.marker.addChild(overlay);
      entry.carried = overlay;
      entry.carriedKind = kind;
    }
  };

  /** A roaming Hog: the shared avatar sprite in its hedgehog skin, feet centred on the
   *  tile (like a trogg). No name label, tint, or ground ring — Hogs are ambient
   *  scenery, not players. */
  const makeHog = (facing: Facing): { marker: Container; sprite: Sprite; frameKey: string } => {
    const tile = getTile();
    const marker = new Container();
    const frame = avatarFrame(false, false, 0);
    const sprite = new Sprite(avatarTexture("hog", facing, frame));
    sprite.anchor.set(ANCHOR.x / FRAME_W, ANCHOR.y / FRAME_H);
    sprite.scale.set(tile / ART);
    sprite.position.set(tile / 2, feetY());
    marker.addChild(sprite);
    return { marker, sprite, frameKey: `${facing}_${frame}` };
  };

  /**
   * Cosmetic easter egg (behind `ghost-trogg`): a pale trogg materialises on the
   * given tile for a heartbeat, then fades — on launch by chance at the origin, or on
   * demand at a random tile via the `/ghost` command. Purely a client render: it
   * touches no table and no reducer (invariant 3), so it's never seen by anyone but
   * the player who summoned it.
   */
  const hauntGhost = (stage: Container, tile: { x: number; y: number }) => {
    audio.playGhost();
    const ghost = new Container();
    const sprite = new Sprite(ghostTexture("down", "idle"));
    sprite.anchor.set(ANCHOR.x / FRAME_W, ANCHOR.y / FRAME_H);
    sprite.scale.set(getTile() / ART);
    sprite.position.set(getTile() / 2, feetY());
    sprite.alpha = 0.5;
    ghost.addChild(sprite);
    place(ghost, tile.x, tile.y);
    stage.addChild(ghost);

    setTimeout(() => ghost.destroy({ children: true }), GHOST_FLICKER_MS);
  };

  /** Build a speech bubble floating just above a head — `topY` is the head top in sprite
   *  mode, the cell top for the placeholder marker. */
  const makeBubble = (text: string, topY: number): Container => {
    const bubble = new Container();
    const label = new Text({
      text,
      style: { fontFamily: "monospace", fontSize: 11, fill: 0x0a0806, align: "center", wordWrap: true, wordWrapWidth: 150 },
      resolution: TEXT_RESOLUTION,
    });
    label.anchor.set(0.5, 1);
    const padX = 5;
    const padY = 3;
    const bg = new Graphics()
      .roundRect(-label.width / 2 - padX, -label.height - padY, label.width + padX * 2, label.height + padY * 2, 4)
      .fill(0xe8dcc4);
    label.position.set(0, padY);
    bubble.addChild(bg, label);
    bubble.position.set(getTile() / 2, topY - 16);
    return bubble;
  };

  return { feetY, headTopY, place, centre, makeMarker, animate, driveSprite, makeBoulder, makeCarried, applyCarry, makeHog, hauntGhost, makeBubble };
}

export type Entities = ReturnType<typeof createEntities>;
