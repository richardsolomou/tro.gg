import Phaser from "phaser";
import { ANCHOR, attackArmStyle, FRAME_H, FRAME_W, forward, hasArmOverlay, hasChopOverlay, HOG_MAX_HEALTH, ITEM_ART_W, PLAYER_MAX_HEALTH, hogSize, timestampMs, type EquipSlot, type Facing, type FrameName, type Kind, type ProjectedMotion, type Stamp } from "@trogg/shared";
import type { Boulder, GroundItem, Hog, Player } from "../net/module_bindings/types";
import { attackFrame, AVATAR_ARM_TEX, AVATAR_CHOP_ARM_TEX, AVATAR_TEX, avatarFrame, avatarFrameName, facingFromDir, GHOST_FRAME, GHOST_TEX } from "./avatars.js";
import { hasItemArt, ITEM_TEX } from "./items.js";
import { ART, attackEase, flinchPose, heldTransform } from "./equipment.js";
import { cssColor, TEXT_RESOLUTION } from "../ui_text.js";
import { audio } from "../audio.js";

export { ART };
/** Carried tile-sized objects stay full tile size; pickup changes position, not scale. */
const CARRY_SCALE = 1;
/** How long a visible equipment use impulse lasts — a quick strike plus a recovery tail. */
const EQUIPMENT_ACTION_MS = 300;
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

/** A live equipped-item overlay and the item/facing it currently shows, so it rebuilds only on change. */
interface EquipOverlay {
  glyph: Phaser.GameObjects.Container;
  kind: string;
  facing: Facing;
}

/** The equip slots rendered as hand overlays, paired with how to read each from a player row. */
const EQUIP_SLOTS: { slot: EquipSlot; item: (p: Player) => string }[] = [
  { slot: "mainHand", item: (p) => p.equippedMainHand },
  { slot: "offHand", item: (p) => p.equippedOffHand },
];

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
  /** The player's stable tint colour, kept so a hit flash can restore it after flashing. */
  baseColor: number;
  /** Local monotonic start of the current hit-flinch (recoil + flash), or undefined when none. */
  flinchBaseMs?: number;
  /** The near-arm overlay redrawn over a held main-hand item so the hand grips the weapon. */
  armOverlay?: Phaser.GameObjects.Sprite;
  /** The frame key currently on the sprite, so the ticker only swaps on change. */
  frameKey: string;
  /** Current avatar animation frame, used to keep equipment anchored to the hand. */
  frameName?: FrameName;
  bubble?: Phaser.GameObjects.Container;
  bubbleTimer?: ReturnType<typeof setTimeout>;
  /** The overlay sprite for what the trogg carries (GDD "Interacting"), if any. */
  carried?: Phaser.GameObjects.Container;
  /** Which kind the overlay shows ("" = none), so it only rebuilds on change. */
  carriedKind: string;
  /** Which style the carried overlay shows (only Hogs use it). */
  carriedStyle: string;
  /** Equipped hand overlays keyed by slot, drawn near the hand rather than above the head. */
  equip: Partial<Record<EquipSlot, EquipOverlay>>;
  /** Local monotonic start for the latest synced equipment-use impulse. */
  equipmentActionBaseMs?: number;
  /** Visible countdown while dead, refreshed from `respawnAt` each frame. */
  respawnText?: Phaser.GameObjects.Text;
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
  /** Local monotonic start of the current hit-flinch (recoil + flash), or undefined when none. */
  flinchBaseMs?: number;
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
  const avatarScale = () => getTile() / FRAME_W;

  /** Screen-space y of the top of a trogg's head, for placing labels and bubbles. */
  const headTopY = () => feetY() - FRAME_H * avatarScale();

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
  const makeMarker = (name: string, color: number, style: string, self: boolean, facing: Facing, sprites: boolean, health: number, dead: boolean, respawnAt?: Stamp) => {
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
      sprite.setScale(avatarScale());
      sprite.setTint(color);
      if (dead) sprite.setAlpha(0.45);
      marker.add(sprite);
      frameKey = `${facing}_${frame}`;
    } else {
      const body = scene.add.graphics();
      body.fillStyle(color, dead ? 0.45 : 1).fillRect(2, 2, tile - 4, tile - 4);
      // Your own trogg keeps its colour but gets an outline so you can pick it out.
      if (self) body.lineStyle(2, 0xe8dcc4).strokeRect(2, 2, tile - 4, tile - 4);
      marker.add(body);
    }

    const labelY = sprites ? headTopY() - 8 : -8;
    const label = scene.make.text({
      x: tile / 2,
      y: labelY,
      text: name,
      style: { fontFamily: "monospace", fontSize: "11px", color: cssColor(dead ? 0x9b8a6c : 0xe8dcc4) },
      add: false,
    });
    label.setOrigin(0.5, 1);
    label.setResolution(TEXT_RESOLUTION);
    marker.add(label);

    const hp = Math.max(0, Math.min(PLAYER_MAX_HEALTH, health));
    const ratio = PLAYER_MAX_HEALTH <= 0 ? 0 : hp / PLAYER_MAX_HEALTH;
    const barW = Math.max(16, Math.round(tile * 0.68));
    const barH = Math.max(3, Math.round(tile * 0.09));
    const bar = scene.add.graphics();
    const bx = Math.round((tile - barW) / 2);
    const by = Math.round(labelY + 3);
    bar.fillStyle(0x0a0806, 0.75).fillRect(bx - 1, by - 1, barW + 2, barH + 2);
    bar.fillStyle(dead ? 0x4a3826 : ratio > 0.5 ? 0x76c26a : ratio > 0.25 ? 0xf2c94c : 0xc75c52, 1).fillRect(bx, by, Math.max(0, Math.round(barW * ratio)), barH);
    marker.add(bar);

    let respawnText: Phaser.GameObjects.Text | undefined;
    if (dead && respawnAt) {
      respawnText = scene.make.text({
        x: tile / 2,
        y: by + barH + 11,
        text: respawnCountdown(respawnAt),
        style: { fontFamily: "monospace", fontSize: "10px", color: cssColor(0xf2c94c) },
        add: false,
      });
      respawnText.setOrigin(0.5, 0.5);
      respawnText.setResolution(TEXT_RESOLUTION);
      marker.add(respawnText);
    }

    return { marker, sprite, frameKey, respawnText };
  };

  /** Drive a trogg's facing and walk cycle from synced motion plus standing facing.
   *  No-op for the placeholder marker (no sprite to swap). */
  const animate = (entry: Tracked, now: number, motion: ProjectedMotion) => {
    const moving = motion.dirX !== 0 || motion.dirY !== 0;
    const faceX = moving ? motion.dirX : entry.player.faceX;
    const faceY = moving ? motion.dirY : entry.player.faceY;
    if (entry.sprite) driveSprite(entry.sprite, "trogg", entry.style, faceX, faceY, entry.player.running, entry, now, moving, attackPhase(entry, now));
    if (entry.respawnText && entry.player.respawnAt) entry.respawnText.setText(respawnCountdown(entry.player.respawnAt));
    applyEquipment(entry);
    animateEquipment(entry, now);
    applyFlinch(entry, now);
    syncArmOverlay(entry, now);
  };

  /** Redraw the near (main-hand) arm over the held item so the hand grips the weapon instead of
   *  the weapon covering the arm. The overlay is a full-frame sprite that mirrors the body — same
   *  frame, transform, and tint (so it rides the walk cycle and the hit-flinch) — drawn on top of
   *  the item. It exists only for the front facings that have an overlay frame and while the main
   *  hand holds something; facing up needs none (the arm and item are both behind the body). */
  const syncArmOverlay = (entry: Tracked, now: number): void => {
    const sprite = entry.sprite;
    const frame = entry.frameName ?? "idle";
    const name = avatarFrameName("trogg", entry.style, entry.facing, frame);
    const main = entry.player.equippedMainHand;
    const isAttack = frame === "attack_a" || frame === "attack_b";
    // a chop weapon (pickaxe) on an attack frame uses the overhead chop arm; everything else the
    // neutral arm. The attack base omits the in-front arm, so the overlay supplies it even unarmed.
    const chop = main !== "" && isAttack && attackArmStyle(main) === "chop" && hasChopOverlay(name);
    const tex = chop ? AVATAR_CHOP_ARM_TEX : AVATAR_ARM_TEX;
    const want = sprite !== undefined && (main !== "" || isAttack) && (chop ? hasChopOverlay(name) : hasArmOverlay(name));
    if (!want) {
      entry.armOverlay?.setVisible(false);
      return;
    }
    let ov = entry.armOverlay;
    if (!ov) {
      ov = scene.add.sprite(0, 0, tex, name);
      ov.setOrigin(ANCHOR.x / FRAME_W, ANCHOR.y / FRAME_H);
      ov.setScale(avatarScale());
      entry.marker.add(ov);
      entry.armOverlay = ov;
    }
    ov.setVisible(true);
    ov.setTexture(tex, name);
    ov.setPosition(sprite!.x, sprite!.y); // after applyFlinch, so the arm rides the recoil too
    const fl = entry.flinchBaseMs === undefined ? null : flinchPose(now - entry.flinchBaseMs);
    if (fl?.flash) ov.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
    else ov.setTint(entry.baseColor).setTintMode(Phaser.TintModes.MULTIPLY);
    entry.marker.bringToTop(ov);
  };

  /** Play the hit-flinch on a damaged trogg: a brief recoil away from its facing plus a white
   *  flash, the held item recoiling with it, restored to rest when the flinch ends. */
  const applyFlinch = (entry: Tracked, now: number): void => {
    if (!entry.sprite || entry.flinchBaseMs === undefined) return;
    const tile = getTile();
    const fl = flinchPose(now - entry.flinchBaseMs);
    if (!fl) {
      entry.flinchBaseMs = undefined;
      entry.sprite.setPosition(tile / 2, feetY());
      entry.sprite.setTint(entry.baseColor).setTintMode(Phaser.TintModes.MULTIPLY);
      return;
    }
    const f = forward(entry.facing); // recoil opposite the facing
    const k = tile * 0.1 * fl.shove;
    entry.sprite.setPosition(tile / 2 - f.x * k, feetY() - f.y * k);
    // a solid white fill on the flash beats, the player tint (multiply) otherwise
    if (fl.flash) entry.sprite.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
    else entry.sprite.setTint(entry.baseColor).setTintMode(Phaser.TintModes.MULTIPLY);
    for (const ov of Object.values(entry.equip)) if (ov) ov.glyph.setPosition(ov.glyph.x - f.x * k, ov.glyph.y - f.y * k);
  };

  /** The same hit-flinch for a Hog: recoil opposite its facing plus a white flash. Hogs carry no
   *  tint, so the flash clears back to none. The sprite rests at the centre of its footprint. */
  const applyHogFlinch = (view: HogView, now: number): void => {
    if (view.flinchBaseMs === undefined) return;
    const c = (getTile() * hogSize(view.style)) / 2;
    const fl = flinchPose(now - view.flinchBaseMs);
    if (!fl) {
      view.flinchBaseMs = undefined;
      view.sprite.setPosition(c, c);
      view.sprite.setTint(0xffffff).setTintMode(Phaser.TintModes.MULTIPLY);
      return;
    }
    const f = forward(view.facing);
    const k = getTile() * 0.1 * fl.shove;
    view.sprite.setPosition(c - f.x * k, c - f.y * k);
    if (fl.flash) view.sprite.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
    else view.sprite.setTint(0xffffff).setTintMode(Phaser.TintModes.MULTIPLY);
  };

  /** Progress [0,1) through the current equipment-use action, or undefined when none is
   *  live — drives the wind-up/strike body pose so the trogg's arm actually extends. */
  const attackPhase = (entry: Tracked, now: number): number | undefined => {
    if (entry.equipmentActionBaseMs === undefined || !entry.player.equipmentAction) return undefined;
    const age = now - entry.equipmentActionBaseMs;
    return age >= 0 && age < EQUIPMENT_ACTION_MS ? age / EQUIPMENT_ACTION_MS : undefined;
  };

  const respawnCountdown = (respawnAt: Stamp): string => {
    const remaining = Math.max(0, timestampMs(respawnAt) - Date.now());
    return `Respawn ${Math.ceil(remaining / 1000)}`;
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
    state: { facing: Facing; frameKey: string; frameName?: FrameName },
    now: number,
    moving = dirX !== 0 || dirY !== 0,
    attack?: number,
  ) => {
    state.facing = facingFromDir(dirX, dirY, state.facing);
    const frame = attack !== undefined ? attackFrame(attack) : avatarFrame(moving, running, now);
    state.frameName = frame;
    const key = `${state.facing}_${frame}`;
    if (key === state.frameKey) return;
    sprite.setFrame(avatarFrameName(kind, style, state.facing, frame));
    state.frameKey = key;
  };

  /** A pushable boulder: the chunky pixel-art rock, scaled to fill its tile. */
  const makeBoulder = () => {
    const tile = getTile();
    const wrap = scene.add.container(0, 0);
    const sprite = scene.make.sprite({ x: tile / 2, y: tile / 2, key: ITEM_TEX, frame: "boulder", add: false });
    sprite.setOrigin(0.5, 0.5);
    sprite.setScale(tile / ITEM_ART_W);
    wrap.add(sprite);
    return wrap;
  };

  /**
   * The pixel-art glyph for a prop, used both on the floor and in hand. The
   * sprite is shrunk into `ART` local units so the existing anchor/scale maths
   * (which works in `tile / ART` terms) keeps placing and rotating it unchanged.
   */
  const makeItemGlyph = (item: string, scale = 1): Phaser.GameObjects.Container | undefined => {
    if (!hasItemArt(item)) return undefined;
    const wrap = scene.add.container(0, 0);
    const sprite = scene.make.sprite({ x: 0, y: 0, key: ITEM_TEX, frame: item, add: false });
    sprite.setOrigin(0.5, 0.5);
    sprite.setScale(ART / ITEM_ART_W);
    wrap.add(sprite);
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
      sprite.setScale(avatarScale() * CARRY_SCALE);
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

  /** Sync the main-hand equipment overlay to `player.equippedMainHand`, rebuilding only
   *  on item or facing change (the directional frame and z-order both depend on facing).
   *  All placement comes from the shared `heldTransform`, so the overlay rides the rig
   *  exactly the way the preview shows it. */
  const applyEquipment = (entry: Tracked): void => {
    for (const { slot, item: pick } of EQUIP_SLOTS) {
      const item = pick(entry.player);
      const cur = entry.equip[slot];
      if (item === (cur?.kind ?? "") && entry.facing === cur?.facing) continue;
      cur?.glyph.destroy();
      delete entry.equip[slot];
      if (!item) continue;
      const t = heldTransform({ kind: "trogg", item, facing: entry.facing, frameName: entry.frameName ?? "idle", tile: getTile(), attack: 0, slot });
      const glyph = makeItemGlyph(t.frame, t.scale);
      if (!glyph) continue;
      if (t.flipX) glyph.scaleX = -glyph.scaleX;
      glyph.setPosition(t.x, t.y);
      glyph.setRotation(t.rotation);
      if (t.behind && entry.sprite) entry.marker.addAt(glyph, Math.max(0, entry.marker.getIndex(entry.sprite)));
      else entry.marker.add(glyph);
      entry.equip[slot] = { glyph, kind: item, facing: entry.facing };
    }
  };

  /** Each frame, pin the item to the hand and apply the item's wield pose — eased from
   *  its held pose into its use pose across the attack — so a pickaxe rests low and chops,
   *  and a shovel digs downward, on top of the arm's reach. The placeholder marker (no
   *  sprite, `avatar-sprites` off) has no rig, so the item just sits mid-cell. */
  const animateEquipment = (entry: Tracked, now: number): void => {
    const tile = getTile();
    const phase = attackPhase(entry, now);
    for (const { slot, item: pick } of EQUIP_SLOTS) {
      const ov = entry.equip[slot];
      if (!ov) continue;
      if (!entry.sprite) {
        ov.glyph.setPosition(tile * 0.5, tile * 0.5);
        continue;
      }
      const t = heldTransform({
        kind: "trogg",
        item: pick(entry.player),
        facing: entry.facing,
        frameName: entry.frameName ?? "idle",
        tile,
        attack: phase === undefined ? 0 : attackEase(phase),
        slot,
      });
      ov.glyph.setScale(t.flipX ? -t.scale : t.scale, t.scale);
      ov.glyph.setPosition(t.x, t.y);
      ov.glyph.setRotation(t.rotation);
    }
  };

  /** A roaming Hog: the shared avatar sprite in its hedgehog skin, feet centred on the
   *  tile (like a trogg). No name label, tint, or ground ring — Hogs are ambient
   *  scenery, not players. */
  const makeHog = (style: string, facing: Facing, health: number): { marker: Phaser.GameObjects.Container; sprite: Phaser.GameObjects.Sprite; frameKey: string } => {
    const tile = getTile();
    const size = hogSize(style);
    const marker = scene.add.container(0, 0);
    const frame = avatarFrame(false, false, 0);
    // A big (2×2) hog renders at `size`× scale, feet centred in its `size`-tile
    // footprint (the marker sits on the footprint's top-left tile), head reaching up
    // out of it — the same feet-centred placement a common hog gets in its one tile.
    const sprite = scene.make.sprite({ x: (tile * size) / 2, y: (tile * size) / 2, key: AVATAR_TEX, frame: avatarFrameName("hog", style, facing, frame), add: false });
    sprite.setOrigin(ANCHOR.x / FRAME_W, ANCHOR.y / FRAME_H);
    sprite.setScale(size * avatarScale());
    marker.add(sprite);
    const hp = Math.max(0, Math.min(HOG_MAX_HEALTH, health));
    if (hp < HOG_MAX_HEALTH) {
      const ratio = HOG_MAX_HEALTH <= 0 ? 0 : hp / HOG_MAX_HEALTH;
      const barW = Math.max(14, Math.round(tile * 0.58));
      const barH = Math.max(3, Math.round(tile * 0.08));
      const bx = Math.round((tile - barW) / 2);
      const by = Math.round(headTopY() - 7);
      const bar = scene.add.graphics();
      bar.fillStyle(0x0a0806, 0.72).fillRect(bx - 1, by - 1, barW + 2, barH + 2);
      bar.fillStyle(ratio > 0.5 ? 0x76c26a : ratio > 0.25 ? 0xf2c94c : 0xc75c52, 1).fillRect(bx, by, Math.max(0, Math.round(barW * ratio)), barH);
      marker.add(bar);
    }
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
    sprite.setScale(avatarScale());
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

  return { headTopY, place, centre, makeMarker, animate, driveSprite, makeBoulder, makeGroundItem, applyCarry, applyEquipment, makeHog, applyHogFlinch, hauntGhost, makeBubble };
}

export type Entities = ReturnType<typeof createEntities>;
