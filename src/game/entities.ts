import Phaser from "phaser";
import { ANCHOR, FRAME_H, FRAME_W, ITEMS, timestampMs, type Facing, type Kind, type ProjectedMotion } from "@trogg/shared";
import type { Boulder, GroundItem, Hog, Player } from "../net/module_bindings/types";
import { AVATAR_TEX, avatarFrame, avatarFrameName, facingFromDir, GHOST_FRAME, GHOST_TEX } from "./avatars.js";
import { cssColor, TEXT_RESOLUTION } from "../ui_text.js";
import { audio } from "../audio.js";

/** Art pixels per tile — terrain tiles are drawn at this and scaled up crisply. */
export const ART = 16;
/** Carried tile-sized objects stay full tile size; pickup changes position, not scale. */
const CARRY_SCALE = 1;
/** How long a visible equipment use impulse lasts. */
const EQUIPMENT_ACTION_MS = 240;
/** How long the apparition spends materialising. */
const GHOST_FADE_IN_MS = 900;
/** How long the apparition lingers at full presence. */
const GHOST_HOLD_MS = 2400;
/** How long the apparition spends dissolving. */
const GHOST_FADE_OUT_MS = 1200;
/** Peak opacity for the ghost sheet. */
const GHOST_PEAK_ALPHA = 0.82;
/** How far the ghost can drift from its summoned tile, as a tile fraction. */
const GHOST_DRIFT_TILES = 0.44;
/** Anything `place` can drop on a tile — a marker, a sprite, a stray graphic. */
type Positionable = { setPosition(x: number, y: number): unknown };

function ghostSeed(id: bigint | undefined, x: number, y: number): number {
  const idPart = id === undefined ? 0 : Number(id % 2_147_483_647n);
  return (idPart ^ Math.imul(x + 1, 374_761_393) ^ Math.imul(y + 1, 668_265_263)) >>> 0;
}

/** A player's sprite plus the client-clock instant its current intent arrived. */
export interface Tracked {
  marker: Phaser.GameObjects.Container;
  /** The trogg sprite, or undefined when the `avatar-sprites` flag is off. */
  sprite?: Phaser.GameObjects.Sprite;
  player: Player;
  baseMs: number;
  /** Last facing, kept so an idle trogg holds its heading rather than snapping. */
  facing: Facing;
  /** The chosen/derived body style, baked into the marker; rebuilt when it changes. */
  style: string;
  /** The frame key currently on the sprite, so the ticker only swaps on change. */
  frameKey: string;
  bubble?: Phaser.GameObjects.Container;
  bubbleTimer?: ReturnType<typeof setTimeout>;
  /** The overlay sprite for what the trogg carries (GDD "Interacting"), if any. */
  carried?: Phaser.GameObjects.Container;
  /** Which kind the overlay shows ("" = none), so it only rebuilds on change. */
  carriedKind: string;
  /** Which style the carried overlay shows (only Hogs use it). */
  carriedStyle: string;
  /** The equipped main-hand overlay, drawn near the hand rather than above the head. */
  equipped?: Phaser.GameObjects.Container;
  equippedKind: string;
  equippedFacing?: Facing;
}

/** A boulder's live row plus its sprite. */
export interface BoulderView {
  row: Boulder;
  sprite: Phaser.GameObjects.Container;
}

/** A ground item pickup plus its sprite. */
export interface GroundItemView {
  row: GroundItem;
  sprite: Phaser.GameObjects.Container;
}

/** A roaming Hog's sprite plus the client-clock instant its current intent arrived. */
export interface HogView {
  marker: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Sprite;
  row: Hog;
  baseMs: number;
  facing: Facing;
  /** The hedgehog skin, derived from the Hog's id so a zone reads as a varied crowd. */
  style: string;
  frameKey: string;
}

/**
 * Avatar/scenery builders and tile-space placement, all sized off the live `TILE`
 * metric (`getTile`, which the world resizes in its layout). They build Phaser
 * display objects from game state — no netcode or prediction — so the world and
 * chat layers share one rig. `feetY`/`headTopY` give the in-cell anchor points
 * labels and bubbles hang off of. All objects are created on `scene`.
 */
export function createEntities(scene: Phaser.Scene, getTile: () => number) {
  /**
   * Screen-space y of a trogg's feet within its tile cell, relative to the cell's
   * top-left (where `place` anchors the marker). The feet sit at the cell's vertical
   * centre so the trogg stands in the middle of its tile, not on the bottom-edge seam.
   */
  const feetY = () => getTile() / 2;

  /** Screen-space y of the top of a trogg's head, for placing labels and bubbles. */
  const headTopY = () => feetY() - FRAME_H * (getTile() / ART);

  const place = (marker: Positionable, x: number, y: number) => {
    const tile = getTile();
    marker.setPosition(x * tile, y * tile);
  };

  const centre = (stage: Phaser.GameObjects.Container, viewW: number, viewH: number, cols: number, rows: number) => {
    const tile = getTile();
    stage.setPosition((viewW - cols * tile) / 2, (viewH - rows * tile) / 2);
  };

  /**
   * A trogg. With the `avatar-sprites` flag on, it's the layered avatar sprite
   * (GDD "Avatars and equipment") tinted by the player's stable colour (so the same
   * trogg reads the same colour for everyone), feet at the centre of the tile cell and
   * head extending up out of it. With the flag off it's the placeholder colour marker
   * (a tile-filling rect). Both carry a name label.
   */
  const makeMarker = (name: string, color: number, style: string, self: boolean, facing: Facing, sprites: boolean) => {
    const tile = getTile();
    const marker = scene.add.container(0, 0);
    let sprite: Phaser.GameObjects.Sprite | undefined;
    let frameKey = "";

    if (sprites) {
      const frame = avatarFrame(false, false, 0);
      // Self gets a bright ground ring under the feet so you can pick yourself out.
      if (self) {
        const ring = scene.add.graphics();
        ring.lineStyle(2, 0xe8dcc4).strokeEllipse(tile / 2, feetY(), tile * 0.34 * 2, tile * 0.16 * 2);
        marker.add(ring);
      }
      sprite = scene.make.sprite({ x: tile / 2, y: feetY(), key: AVATAR_TEX, frame: avatarFrameName("trogg", style, facing, frame), add: false });
      // Anchor on the art's feet point (ANCHOR), not the frame's bottom edge, so the
      // feet — not the empty pixels below them — land on the tile centre.
      sprite.setOrigin(ANCHOR.x / FRAME_W, ANCHOR.y / FRAME_H);
      sprite.setScale(tile / ART);
      sprite.setTint(color);
      marker.add(sprite);
      frameKey = `${facing}_${frame}`;
    } else {
      const body = scene.add.graphics();
      body.fillStyle(color, 1).fillRect(2, 2, tile - 4, tile - 4);
      // Your own trogg keeps its colour but gets an outline so you can pick it out.
      if (self) body.lineStyle(2, 0xe8dcc4).strokeRect(2, 2, tile - 4, tile - 4);
      marker.add(body);
    }

    const label = scene.make.text({
      x: tile / 2,
      y: sprites ? headTopY() - 2 : -2,
      text: name,
      style: { fontFamily: "monospace", fontSize: "11px", color: cssColor(0xe8dcc4) },
      add: false,
    });
    label.setOrigin(0.5, 1);
    label.setResolution(TEXT_RESOLUTION);
    marker.add(label);

    return { marker, sprite, frameKey };
  };

  /** Drive a trogg's facing and walk cycle from synced motion plus standing facing.
   *  No-op for the placeholder marker (no sprite to swap). */
  const animate = (entry: Tracked, now: number, motion: ProjectedMotion) => {
    const moving = motion.dirX !== 0 || motion.dirY !== 0;
    const faceX = moving ? motion.dirX : entry.player.faceX;
    const faceY = moving ? motion.dirY : entry.player.faceY;
    if (entry.sprite) driveSprite(entry.sprite, "trogg", entry.style, faceX, faceY, entry.player.running, entry, now, moving);
    applyEquipment(entry);
    animateEquipment(entry);
  };

  /**
   * Point a sprite's facing and stride frame at its motion intent, mutating the
   * caller's `facing`/`frameKey` so the next frame compares against it. Shared by
   * troggs and Hogs (one rig); `running` picks the faster hunched run cycle (troggs
   * only — Hogs always walk). Only touches the GPU when the frame actually changes.
   */
  const driveSprite = (
    sprite: Phaser.GameObjects.Sprite,
    kind: Kind,
    style: string,
    dirX: number,
    dirY: number,
    running: boolean,
    state: { facing: Facing; frameKey: string },
    now: number,
    moving = dirX !== 0 || dirY !== 0,
  ) => {
    state.facing = facingFromDir(dirX, dirY, state.facing);
    const frame = avatarFrame(moving, running, now);
    const key = `${state.facing}_${frame}`;
    if (key === state.frameKey) return;
    sprite.setFrame(avatarFrameName(kind, style, state.facing, frame));
    state.frameKey = key;
  };

  /** A pushable boulder: a rounded stone filling its tile, with a lit top-left face. */
  const makeBoulder = () => {
    const tile = getTile();
    const sprite = scene.add.container(0, 0);
    const inset = Math.max(2, Math.round(tile * 0.1));
    const size = tile - inset * 2;
    const radius = Math.max(3, Math.round(tile * 0.28));
    const px = Math.max(1, Math.round(tile / ART));
    const body = scene.add.graphics();
    body.fillStyle(0x6b5640, 1).fillRoundedRect(inset, inset, size, size, radius);
    body.lineStyle(px, 0x2a2118, 1).strokeRoundedRect(inset, inset, size, size, radius);
    // A small highlight reads as a lit facet under the cave's torchlight.
    body.fillStyle(0x8a7257, 1).fillRoundedRect(inset + px, inset + px, size * 0.4, size * 0.4, radius * 0.6);
    sprite.add(body);
    return sprite;
  };

  const toolColor = (item: string): number => {
    if (item === "pickaxe") return 0xaec4c8;
    if (item === "shovel") return 0xc79b56;
    if (item === "sword") return 0xdce9ee;
    return 0x9b8a6c;
  };

  /** A compact programmer-art item glyph used both on the floor and in hand. */
  const makeItemGlyph = (item: string, scale = 1): Phaser.GameObjects.Container | undefined => {
    if (item === "stone") {
      const wrap = scene.add.container(0, 0);
      const g = scene.add.graphics();
      g.fillStyle(0x6b5640, 1).fillRoundedRect(-4, -3, 8, 6, 3);
      g.lineStyle(1, 0x2a2118, 1).strokeRoundedRect(-4, -3, 8, 6, 3);
      wrap.add(g);
      wrap.setScale(scale);
      return wrap;
    }

    const def = ITEMS[item as keyof typeof ITEMS];
    if (!def?.sprite) return undefined;
    const wrap = scene.add.container(0, 0);
    const g = scene.add.graphics();
    const metal = toolColor(item);
    const handle = 0x6b3f24;
    if (item === "pickaxe") {
      g.lineStyle(2, handle, 1).lineBetween(0, 5, 0, -7);
      g.lineStyle(2, metal, 1).lineBetween(-6, -7, 6, -7);
      g.lineStyle(1, 0xe8dcc4, 1).lineBetween(-4, -8, 4, -8);
    } else if (item === "shovel") {
      g.lineStyle(2, handle, 1).lineBetween(0, 5, 0, -6);
      g.fillStyle(metal, 1).fillEllipse(0, -8, 8, 6);
      g.lineStyle(1, 0x2a2118, 1).strokeEllipse(0, -8, 8, 6);
    } else if (item === "sword") {
      g.lineStyle(2, metal, 1).lineBetween(0, 6, 0, -9);
      g.lineStyle(2, 0xf2c94c, 1).lineBetween(-4, 1, 4, 1);
      g.lineStyle(2, handle, 1).lineBetween(0, 2, 0, 7);
    }
    wrap.add(g);
    wrap.setScale(scale);
    return wrap;
  };

  /** A pickup item lying on the floor, distinct from an equipped hand overlay. */
  const makeGroundItem = (item: string): Phaser.GameObjects.Container => {
    const tile = getTile();
    const wrap = scene.add.container(0, 0);
    const shadow = scene.add.graphics();
    shadow.fillStyle(0x0a0806, 0.35).fillEllipse(tile / 2, tile * 0.68, tile * 0.42, tile * 0.18);
    wrap.add(shadow);
    const glyph = makeItemGlyph(item, Math.max(1.2, tile / ART));
    if (glyph) {
      glyph.setPosition(tile / 2, tile * 0.56);
      glyph.setRotation(item === "sword" ? Math.PI / 4 : item === "pickaxe" ? -Math.PI / 4 : 0.2);
      wrap.add(glyph);
    }
    return wrap;
  };

  /**
   * The overlay for what a trogg carries (GDD "Interacting"): the held object drawn
   * at full tile size on the trogg's person above its head — a boulder, a hog, and
   * (later) any tile-sized thing all read the same held way. `topY` is the head top in sprite
   * mode, the cell top for the placeholder marker. Unknown kind → no overlay.
   */
  const makeCarried = (kind: string, style: string, topY: number): Phaser.GameObjects.Container | undefined => {
    const tile = getTile();
    const wrap = scene.add.container(0, 0);
    if (kind === "boulder") {
      const b = makeBoulder();
      // The boulder spans [0, tile]; shift so its centre — not its corner — sits on
      // the wrap origin (Phaser containers transform about (0, 0)).
      b.setScale(CARRY_SCALE);
      b.setPosition((-tile * CARRY_SCALE) / 2, (-tile * CARRY_SCALE) / 2);
      wrap.add(b);
    } else if (kind === "hog") {
      const sprite = scene.make.sprite({ x: 0, y: 0, key: AVATAR_TEX, frame: avatarFrameName("hog", style, "down", "idle"), add: false });
      sprite.setOrigin(ANCHOR.x / FRAME_W, ANCHOR.y / FRAME_H);
      sprite.setScale((tile / ART) * CARRY_SCALE);
      wrap.add(sprite);
    } else {
      wrap.destroy();
      return undefined;
    }
    wrap.setPosition(tile / 2, topY - 2);
    return wrap;
  };

  /** Sync a trogg's carried overlay to its `carrying` kind, rebuilding only on change. */
  const applyCarry = (entry: Tracked): void => {
    const kind = entry.player.carrying;
    const style = kind === "hog" ? entry.player.carryingStyle || "classic" : "";
    if (kind === entry.carriedKind && style === entry.carriedStyle) return;
    entry.carried?.destroy();
    entry.carried = undefined;
    entry.carriedKind = "";
    entry.carriedStyle = "";
    const overlay = makeCarried(kind, style, entry.sprite ? headTopY() : 0);
    if (overlay) {
      entry.marker.add(overlay);
      entry.carried = overlay;
      entry.carriedKind = kind;
      entry.carriedStyle = style;
    }
  };

  const equipmentAnchor = (entry: Tracked): { x: number; y: number; rotation: number; scale: number } => {
    const tile = getTile();
    const baseY = entry.sprite ? feetY() - tile * 0.42 : tile * 0.5;
    if (entry.facing === "left") return { x: tile * 0.28, y: baseY, rotation: -0.8, scale: tile / ART };
    if (entry.facing === "right") return { x: tile * 0.72, y: baseY, rotation: 0.8, scale: tile / ART };
    if (entry.facing === "up") return { x: tile * 0.36, y: baseY - tile * 0.08, rotation: -0.35, scale: tile / ART };
    return { x: tile * 0.66, y: baseY, rotation: 0.35, scale: tile / ART };
  };

  /** Sync the main-hand equipment overlay to `player.equippedMainHand`. */
  const applyEquipment = (entry: Tracked): void => {
    const item = entry.player.equippedMainHand;
    if (item === entry.equippedKind && entry.facing === entry.equippedFacing) return;
    entry.equipped?.destroy();
    entry.equipped = undefined;
    entry.equippedKind = "";
    entry.equippedFacing = undefined;
    const anchor = equipmentAnchor(entry);
    const glyph = makeItemGlyph(item, anchor.scale);
    if (!glyph) return;
    glyph.setPosition(anchor.x, anchor.y);
    glyph.setRotation(anchor.rotation);
    entry.marker.add(glyph);
    entry.equipped = glyph;
    entry.equippedKind = item;
    entry.equippedFacing = entry.facing;
  };

  /** Briefly exaggerate the equipped item when the server syncs an equipment use. */
  const animateEquipment = (entry: Tracked): void => {
    if (!entry.equipped || entry.player.equipmentAction !== entry.equippedKind) return;
    const age = Date.now() - timestampMs(entry.player.equipmentActionAt);
    const t = Math.max(0, Math.min(1, age / EQUIPMENT_ACTION_MS));
    const anchor = equipmentAnchor(entry);
    const swing = age >= 0 && age < EQUIPMENT_ACTION_MS ? Math.sin(t * Math.PI) : 0;
    const side = entry.facing === "left" || entry.facing === "up" ? -1 : 1;
    entry.equipped.setRotation(anchor.rotation + swing * 0.85 * side);
    entry.equipped.setPosition(anchor.x + swing * side * getTile() * 0.08, anchor.y - swing * getTile() * 0.08);
  };

  /** A roaming Hog: the shared avatar sprite in its hedgehog skin, feet centred on the
   *  tile (like a trogg). No name label, tint, or ground ring — Hogs are ambient
   *  scenery, not players. */
  const makeHog = (style: string, facing: Facing): { marker: Phaser.GameObjects.Container; sprite: Phaser.GameObjects.Sprite; frameKey: string } => {
    const tile = getTile();
    const marker = scene.add.container(0, 0);
    const frame = avatarFrame(false, false, 0);
    const sprite = scene.make.sprite({ x: tile / 2, y: feetY(), key: AVATAR_TEX, frame: avatarFrameName("hog", style, facing, frame), add: false });
    sprite.setOrigin(ANCHOR.x / FRAME_W, ANCHOR.y / FRAME_H);
    sprite.setScale(tile / ART);
    marker.add(sprite);
    return { marker, sprite, frameKey: `${facing}_${frame}` };
  };

  /**
   * Cosmetic easter egg (behind `ghost-trogg`): a pale draped ghost materialises on
   * the given tile, drifts gently, lingers, then fades. The Commands panel requests
   * `hauntGhost`; every live client in the zone renders the resulting `ghost_haunt`
   * insert.
   */
  const hauntGhost = (stage: Phaser.GameObjects.Container, tile: { x: number; y: number; id?: bigint }) => {
    audio.playGhost();
    const ghost = scene.add.container(0, 0);
    const sprite = scene.make.sprite({ x: getTile() / 2, y: feetY(), key: GHOST_TEX, frame: GHOST_FRAME, add: false });
    sprite.setOrigin(ANCHOR.x / FRAME_W, ANCHOR.y / FRAME_H);
    sprite.setScale(getTile() / ART);
    ghost.add(sprite);
    ghost.setAlpha(0);
    place(ghost, tile.x, tile.y);
    stage.add(ghost);

    const seed = ghostSeed(tile.id, tile.x, tile.y);
    const angle = ((seed % 360) * Math.PI) / 180;
    const drift = getTile() * GHOST_DRIFT_TILES;
    const dx = Math.cos(angle) * drift;
    const dy = Math.sin(angle) * drift * 0.72;
    const fadeOutDelayMs = GHOST_FADE_IN_MS + GHOST_HOLD_MS;
    const lifetimeMs = fadeOutDelayMs + GHOST_FADE_OUT_MS;

    scene.tweens.add({ targets: ghost, alpha: GHOST_PEAK_ALPHA, duration: GHOST_FADE_IN_MS, ease: "Sine.easeInOut" });
    scene.tweens.add({ targets: ghost, x: ghost.x + dx, y: ghost.y + dy, duration: lifetimeMs, ease: "Sine.easeInOut" });
    scene.tweens.add({
      targets: ghost,
      alpha: 0,
      duration: GHOST_FADE_OUT_MS,
      delay: fadeOutDelayMs,
      ease: "Sine.easeInOut",
      onComplete: () => ghost.destroy(),
    });
  };

  /** Build a speech bubble floating just above a head — `topY` is the head top in sprite
   *  mode, the cell top for the placeholder marker. */
  const makeBubble = (text: string, topY: number): Phaser.GameObjects.Container => {
    const bubble = scene.add.container(0, 0);
    const label = scene.make.text({
      x: 0,
      y: 3,
      text,
      style: { fontFamily: "monospace", fontSize: "11px", color: cssColor(0x0a0806), align: "center", wordWrap: { width: 150 } },
      add: false,
    });
    label.setOrigin(0.5, 1);
    label.setResolution(TEXT_RESOLUTION);
    const padX = 5;
    const padY = 3;
    const bg = scene.add.graphics();
    bg.fillStyle(0xe8dcc4, 1).fillRoundedRect(-label.width / 2 - padX, -label.height - padY, label.width + padX * 2, label.height + padY * 2, 4);
    bubble.add([bg, label]);
    bubble.setPosition(getTile() / 2, topY - 16);
    return bubble;
  };

  return { headTopY, place, centre, makeMarker, animate, driveSprite, makeBoulder, makeGroundItem, applyCarry, applyEquipment, makeHog, hauntGhost, makeBubble };
}

export type Entities = ReturnType<typeof createEntities>;
