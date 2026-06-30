import Phaser from "phaser";
import { ANCHOR, attackArmStyle, blitArt, composeAvatarFrame, FACINGS, forward, FRAME_H, FRAME_W, hasArmOverlay, hasChopOverlay, hasHogBall, hogBallFrameName, hogSize, ITEM_ART, ITEM_ART_H, ITEM_ART_W, ITEMS as ITEM_DEFS, jointAt, KINDS, rgbaSink, stylesOf, type EquipSlot, type Facing, type FrameName, type JointName, type Kind } from "@trogg/shared";
import { AVATAR_FRAME_ART, type IndexedSpriteArt } from "../../shared/sprite_art.js";
import { ART, attackEase, FLINCH_MS, flinchPose, heldGroup, heldTransform } from "../game/equipment.js";
import { attackFrame, AVATAR_ARM_TEX, AVATAR_BALL_TEX, AVATAR_CHOP_ARM_TEX, avatarFrame, avatarFrameName, AVATAR_TEX, registerAvatarTextures } from "../game/avatars.js";
import { ITEM_TEX, registerItemTextures } from "../game/items.js";

/**
 * Dev-only art preview (not shipped game). One connectionless Phaser scene — no
 * SpacetimeDB, no auth, no netcode — with two mutually-exclusive views:
 *
 *  - **holder**: the selected creature, in all four facings, animated through idle/walk/run/
 *    attack, holding the selected item (or empty-handed when item = `none`). Held items are
 *    placed by the *same* `heldTransform` (`src/game/equipment.ts`) the live game uses, so
 *    what you see is what the rig does in-world — use it to spot where a held item lands
 *    wrong. Items with no directional in-hand art (boulder, stone) are shown gripped via
 *    their base sprite.
 *  - **item**: the selected item's art on its own, across whichever views it has — the upright
 *    overworld icon plus any directional in-hand frames (down/up/left/right) — so you can
 *    design and eyeball it from every face without a creature in the way.
 *
 * Both selectors are inventory-style icon palettes (hover a slot for its name) and both are
 * auto-discovered, so this page never needs a hand-maintained list: every drawable item
 * (whatever has `ITEM_ART`, equippable or not) and every creature variant (`KINDS` × each
 * kind's styles — every trogg and every hog, buff/dino/chicken included).
 */

const NONE = "none";
/** Every item the game knows about, discovered automatically so this page never needs a
 *  hand-maintained list: the union of the gameplay registry (`ITEMS`) and everything with
 *  art (`ITEM_ART` base names, stripped of the `_down`/`_up`/`_side` directional suffixes —
 *  so `sword`/`sword_down`/… collapse to `sword`). Covers equippables, props like the
 *  boulder/stone, and any future item — registered, drawn, or both. */
const ALL_ITEMS = [...new Set([...Object.keys(ITEM_ART).map((k) => k.replace(/_(down|up|side)$/, "")), ...Object.keys(ITEM_DEFS)])];
/** The display name for an item id (registry name when it has one, else the id capitalised). */
const itemName = (id: string) => ITEM_DEFS[id as keyof typeof ITEM_DEFS]?.name ?? id.charAt(0).toUpperCase() + id.slice(1);
/** Every creature variant — each kind crossed with each of its styles — auto-derived, so a
 *  new kind or style shows up here with no edit (every trogg + every hog, buff/dino/chicken). */
const CREATURES: { kind: Kind; style: string }[] = KINDS.flatMap((kind) => stylesOf(kind).map((style) => ({ kind, style })));
const VIEWS = ["holder", "item"] as const;
type View = (typeof VIEWS)[number];
const MODES = ["idle", "walk", "run", "attack", "hit", "ball", "auto"] as const;
type Mode = (typeof MODES)[number];
/** One hit-flinch play-through plus a pause, so the `hit` mode loops it visibly. */
const HIT_CYCLE_MS = FLINCH_MS + 500;

/** Columns of the item view: the upright overworld icon, then the directional in-hand frames
 *  (`left` is the right profile mirrored, matching how the runtime draws it). */
const ITEM_VIEWS: { label: string; suffix: string; flip: boolean }[] = [
  { label: "icon", suffix: "", flip: false },
  { label: "down", suffix: "_down", flip: false },
  { label: "up", suffix: "_up", flip: false },
  { label: "left", suffix: "_side", flip: true },
  { label: "right", suffix: "_side", flip: false },
];

/** One full attack play-through, slowed from the in-game impulse so it reads. */
const ATTACK_CYCLE_MS = 1100;
/** Auto-mode segment lengths, ms — idle, walk, run, attack. */
const AUTO_SEGMENTS: [Mode, number][] = [
  ["idle", 1000],
  ["walk", 1700],
  ["run", 1700],
  ["attack", ATTACK_CYCLE_MS * 2],
];

/** Prefer a wieldable item as the default — it shows the rig off better than a bare prop. */
const DEFAULT_ITEM = ALL_ITEMS.find((id) => ITEM_ART[`${id}_side`]) ?? ALL_ITEMS[0] ?? NONE;

/** Off-hand options — `none`, or the shield (the canonical off-hand item). */
const OFF_ITEMS = [NONE, "shield"].filter((id) => id === NONE || ITEM_ART[id]);

const controls = {
  view: "holder" as View,
  item: DEFAULT_ITEM,
  offItem: NONE, // off-hand (shield), to show the slot + per-slot z-order
  creatureIdx: 0, // index into CREATURES
  mode: "auto" as Mode,
  paused: false,
  scrub: 0.5, // manual attack phase while paused
  bones: false, // skeleton overlay — draw the rig joints/bones over the sprite
};

/** Override `controls` from the URL query, so a preview state is a shareable deep link and
 *  the Playwright harness can address one (e.g. `/preview?creature=hog:buff&item=sword&off=shield&mode=attack&paused=1&scrub=0.35`).
 *  Unknown or malformed values are ignored, so a bad link still boots the default preview. */
function applyUrlControls() {
  const q = new URLSearchParams(location.search);
  const flag = (v: string | null) => v === "1" || v === "true";

  const view = q.get("view");
  if (view && (VIEWS as readonly string[]).includes(view)) controls.view = view as View;

  const item = q.get("item");
  if (item && (item === NONE || ALL_ITEMS.includes(item))) controls.item = item;

  const off = q.get("off");
  if (off && OFF_ITEMS.includes(off)) controls.offItem = off;

  const creature = q.get("creature");
  if (creature) {
    const idx = /^\d+$/.test(creature)
      ? Number(creature)
      : CREATURES.findIndex((c) => `${c.kind}:${c.style}` === creature || `${c.style} ${c.kind}` === creature);
    if (idx >= 0 && idx < CREATURES.length) controls.creatureIdx = idx;
  }

  const mode = q.get("mode");
  if (mode && (MODES as readonly string[]).includes(mode)) controls.mode = mode as Mode;

  if (q.has("paused")) controls.paused = flag(q.get("paused"));
  if (q.has("bones")) controls.bones = flag(q.get("bones"));

  const scrub = q.get("scrub");
  if (scrub !== null && !Number.isNaN(Number(scrub))) controls.scrub = Math.min(1, Math.max(0, Number(scrub)));
}

/** The atlas frame to draw for a held item at this facing: the directional in-hand frame
 *  when the item has one, else its base sprite (boulder/stone have no per-facing art). */
function heldFrame(item: string, facing: Facing): string {
  const dir = `${item}${heldGroup(facing)}`;
  return ITEM_ART[dir] ? dir : item;
}

/** The animation frame + attack weight for a creature at time `t`, given the mode. */
function poseAt(mode: Mode, t: number): { frame: FrameName; attack: number } {
  if (mode === "auto") {
    const total = AUTO_SEGMENTS.reduce((n, [, ms]) => n + ms, 0);
    let r = t % total;
    for (const [seg, ms] of AUTO_SEGMENTS) {
      if (r < ms) return poseAt(seg, t);
      r -= ms;
    }
  }
  if (mode === "attack") {
    const phase = controls.paused ? controls.scrub : (t % ATTACK_CYCLE_MS) / ATTACK_CYCLE_MS;
    return { frame: attackFrame(phase), attack: attackEase(phase) };
  }
  if (mode === "walk") return { frame: avatarFrame(true, false, t), attack: 0 };
  if (mode === "run") return { frame: avatarFrame(true, true, t), attack: 0 };
  return { frame: "idle", attack: 0 }; // idle, and the body pose under a `hit` flinch
}

/** A held cell: the creature and (unless empty-handed) its item, reordered each frame for z-order. */
interface HeldCell {
  kind: Kind;
  style: string;
  facing: Facing;
  rig: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Sprite;
  item?: Phaser.GameObjects.Sprite;
  offItem?: Phaser.GameObjects.Sprite;
  /** The near-arm overlay redrawn over the main-hand item (front facings only). */
  arm: Phaser.GameObjects.Sprite;
  bones: Phaser.GameObjects.Graphics;
  /** The rig container's resting position, so the hit-flinch can recoil it and return. */
  bx: number;
  by: number;
}

/** A creature's footprint multiplier: big hogs (buff/dino) span 2×, everything else 1× —
 *  the same `hogSize` the game scales them by, so they read large here too. */
const creatureSize = (kind: Kind, style: string) => (kind === "hog" ? hogSize(style) : 1);

class PreviewScene extends Phaser.Scene {
  /** Base cell size; the working `tile` is this times the rendered creature's footprint. */
  private readonly baseTile = 132;
  private tile = 132;
  private readonly pad = 26;
  private readonly headerH = 34;
  private root!: Phaser.GameObjects.Container;
  private heldCells: HeldCell[] = [];
  /** Animation clock — advances only while not paused, so pausing holds the frame. */
  private clock = 0;
  /** Signature of what's currently laid out; a change triggers a self-rebuild in `update`. */
  private builtSig = "";
  /** Set once the first frame has been drawn, so a test can wait for a painted canvas. */
  private rendered = false;
  /** Laid-out grid extent, for `layout` to centre/scale. */
  private gridCols = 1;
  private gridRows = 1;

  constructor() {
    super("preview");
  }

  create() {
    registerAvatarTextures(this);
    registerItemTextures(this);
    this.root = this.add.container(0, 0);
    this.rebuild();
    this.scale.on("resize", () => this.layout());
  }

  /** What the laid-out grid depends on; cheap to compare each frame. */
  private buildSig() {
    return `${controls.view}|${controls.item}|${controls.offItem}|${controls.creatureIdx}`;
  }

  /** Tear down and re-lay the grid for the current view — driven by `update` when `buildSig`
   *  changes; per-frame motion is handled in `update`. */
  rebuild() {
    this.builtSig = this.buildSig();
    this.root.removeAll(true);
    this.heldCells = [];
    if (controls.view === "item") this.buildItemView();
    else this.buildHolderView();
    this.layout();
  }

  private colX = (c: number) => this.pad + c * (this.tile + this.pad);

  /** Holder view: the selected creature across all facings, holding the selected item (or none).
   *  Big creatures (buff/dino hogs) render larger via their footprint multiplier. */
  private buildHolderView() {
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const { kind, style } = CREATURES[controls.creatureIdx] ?? CREATURES[0]!;
    this.tile = this.baseTile * creatureSize(kind, style);
    FACINGS.forEach((f, c) => this.label(this.colX(c) + this.tile / 2, 6, cap(f), "#9b8a6c", 0.5));

    const y = this.headerH;
    this.label(6, y + this.tile / 2, `${style} ${kind}`, "#e8dcc4", 0, 90);
    FACINGS.forEach((facing, c) => {
      const rig = this.add.container(this.colX(c), y);
      const body = this.add.sprite(this.tile / 2, this.tile / 2, AVATAR_TEX, avatarFrameName(kind, style, facing, "idle"));
      body.setOrigin(ANCHOR.x / FRAME_W, ANCHOR.y / FRAME_H);
      body.setScale(this.tile / FRAME_W);
      rig.add(body);
      // skip a hand when empty, or when a registered item has no art yet (nothing to draw)
      const makeHeld = (id: string) => {
        if (id === NONE || !ITEM_ART[heldFrame(id, facing)]) return undefined;
        const s = this.add.sprite(0, 0, ITEM_TEX, heldFrame(id, facing));
        s.setOrigin(0.5, 0.5);
        rig.add(s);
        return s;
      };
      const item = makeHeld(controls.item);
      const offItem = makeHeld(controls.offItem);
      const arm = this.add.sprite(this.tile / 2, this.tile / 2, AVATAR_ARM_TEX, avatarFrameName(kind, style, facing, "idle"));
      arm.setOrigin(ANCHOR.x / FRAME_W, ANCHOR.y / FRAME_H);
      arm.setScale(this.tile / FRAME_W);
      arm.setVisible(false);
      rig.add(arm);
      const bones = this.add.graphics();
      rig.add(bones);
      this.root.add(rig);
      this.heldCells.push({ kind, style, facing, rig, body, item, offItem, arm, bones, bx: this.colX(c), by: y });
    });
    this.gridCols = FACINGS.length;
    this.gridRows = 1;
  }

  /** Item view: the selected item laid out across whichever views it has (overworld icon +
   *  any directional in-hand frames), so you can eyeball it from every face. */
  private buildItemView() {
    this.tile = this.baseTile;
    const id = controls.item;
    const views = ITEM_VIEWS.filter((v) => ITEM_ART[`${id}${v.suffix}`]);
    const y = this.headerH;
    this.label(6, y + this.tile / 2, itemName(id), "#e8dcc4", 0, 90);
    if (views.length === 0) this.label(this.colX(0) + this.tile / 2, y + this.tile / 2, "(no art yet)", "#9b8a6c", 0.5);
    views.forEach((v, c) => {
      this.label(this.colX(c) + this.tile / 2, 6, v.label, "#9b8a6c", 0.5);
      const cx = this.colX(c) + this.tile / 2;
      const cy = y + this.tile / 2;
      const sprite = this.add.sprite(cx, cy, ITEM_TEX, `${id}${v.suffix}`);
      sprite.setOrigin(0.5, 0.5);
      const px = (this.tile * 0.7) / ITEM_ART_W;
      sprite.setScale(v.flip ? -px : px, px);
      this.root.add(sprite);
    });
    this.gridCols = Math.max(1, views.length);
    this.gridRows = 1;
  }

  private label(x: number, y: number, text: string, color: string, originX: number, angle = 0) {
    const t = this.add.text(x, y, text, { fontFamily: "monospace", fontSize: "13px", color });
    t.setOrigin(originX, 0.5);
    t.setAngle(angle);
    this.root.add(t);
  }

  /** Centre the grid and scale it down to fit the viewport. */
  private layout() {
    const w = this.pad + this.gridCols * (this.tile + this.pad);
    const h = this.headerH + this.gridRows * (this.tile + this.pad);
    const vw = this.scale.width;
    const vh = this.scale.height;
    const s = Math.min(1, (vw - 20) / w, (vh - this.headerH - 20) / h);
    this.root.setScale(s);
    this.root.setPosition((vw - w * s) / 2, this.headerH + 8 + Math.max(0, (vh - this.headerH - 8 - h * s) / 2));
  }

  update(_time: number, delta: number) {
    if (this.buildSig() !== this.builtSig) this.rebuild();
    if (!controls.paused) this.clock += delta;
    const time = this.clock;
    const itemPx = (s: number) => s * (ART / ITEM_ART_W); // heldTransform.scale → sprite scale

    for (const cell of this.heldCells) {
      const { frame, attack } = poseAt(controls.mode, time);

      // ball mode: a common hog curls into its facing-independent defensive ball; no item or arm.
      const ballMode = controls.mode === "ball" && cell.kind === "hog" && hasHogBall(cell.style);
      if (ballMode) {
        cell.body.setTexture(AVATAR_BALL_TEX, hogBallFrameName(cell.style));
        cell.item?.setVisible(false);
        cell.offItem?.setVisible(false);
        cell.arm.setVisible(false);
        cell.bones.clear();
        this.applyHit(cell, time);
        continue;
      }
      cell.item?.setVisible(true);
      cell.offItem?.setVisible(true);

      // hog has no wielding rig of its own yet; it shares the trogg skeleton (rig.ts),
      // so it still demonstrates the shared placement.
      cell.body.setTexture(AVATAR_TEX, avatarFrameName(cell.kind, cell.style, cell.facing, frame));

      // place each held hand, returning its z-order (behind the body or in front)
      const place = (sprite: Phaser.GameObjects.Sprite | undefined, id: string, slot: EquipSlot) => {
        if (!sprite) return undefined;
        const t = heldTransform({ kind: cell.kind, item: id, facing: cell.facing, frameName: frame, tile: this.tile, attack, slot });
        sprite.setFrame(heldFrame(id, cell.facing));
        sprite.setScale(t.flipX ? -itemPx(t.scale) : itemPx(t.scale), itemPx(t.scale));
        sprite.setPosition(t.x, t.y);
        sprite.setRotation(t.rotation);
        return t.behind;
      };
      const mainBehind = place(cell.item, controls.item, "mainHand");
      const offBehind = place(cell.offItem, controls.offItem, "offHand");

      // the near (main) arm redrawn over the main-hand item, so the hand grips the weapon. A chop
      // weapon (pickaxe) on an attack frame uses the overhead chop arm; the attack base omits the
      // in-front arm, so the overlay supplies it even when empty-handed.
      const armName = avatarFrameName(cell.kind, cell.style, cell.facing, frame);
      const isAttack = frame === "attack_a" || frame === "attack_b";
      const chop = !!cell.item && isAttack && attackArmStyle(controls.item) === "chop" && hasChopOverlay(armName);
      const showArm = (!!cell.item || isAttack) && (chop ? hasChopOverlay(armName) : hasArmOverlay(armName));
      cell.arm.setVisible(showArm);
      if (showArm) cell.arm.setTexture(chop ? AVATAR_CHOP_ARM_TEX : AVATAR_ARM_TEX, armName);

      // layer back→front: behind-hand items, body, front-hand items, then the near arm over its item
      const order: Phaser.GameObjects.GameObject[] = [];
      if (cell.offItem && offBehind) order.push(cell.offItem);
      if (cell.item && mainBehind) order.push(cell.item);
      order.push(cell.body);
      if (cell.offItem && !offBehind) order.push(cell.offItem);
      if (cell.item && !mainBehind) order.push(cell.item);
      if (showArm) order.push(cell.arm);
      for (const o of order) cell.rig.bringToTop(o);

      this.drawBones(cell, frame);
      this.applyHit(cell, time);
    }

    // Signal a painted canvas exactly once, so the harness can wait on a stable first frame.
    if (!this.rendered) {
      this.rendered = true;
      (window as typeof window & { __previewReady?: boolean }).__previewReady = true;
    }
  }

  /** The `hit` mode: recoil the whole rig opposite its facing and flash the body white, on a
   *  loop — the same `flinchPose` the game plays on damage. Resets the rig when not in `hit`. */
  private applyHit(cell: HeldCell, time: number) {
    const fl = controls.mode === "hit" ? flinchPose(time % HIT_CYCLE_MS) : null;
    const mode = fl?.flash ? Phaser.TintModes.FILL : Phaser.TintModes.MULTIPLY;
    cell.body.setTint(0xffffff).setTintMode(mode);
    cell.arm.setTint(0xffffff).setTintMode(mode); // the near arm flashes with the body
    if (!fl) {
      cell.rig.setPosition(cell.bx, cell.by);
      return;
    }
    const f = forward(cell.facing);
    const k = this.tile * 0.1 * fl.shove;
    cell.rig.setPosition(cell.bx - f.x * k, cell.by - f.y * k);
  }

  /** Skeleton overlay: the rig's bones (shoulder→hand, hip→foot) and joints drawn over the body
   *  for the current frame, so the rig is visible while editing/verifying. Cleared when off. */
  private drawBones(cell: HeldCell, frame: FrameName) {
    const g = cell.bones;
    g.clear();
    if (!controls.bones) return;
    const sf = this.tile / FRAME_W;
    // left is the mirror of right (matching the baked body), so source `right` and flip x
    const pf: Facing = cell.facing === "left" ? "right" : cell.facing;
    const at = (j: JointName) => {
      const p = jointAt(cell.kind, pf, frame, j);
      const jx = cell.facing === "left" ? FRAME_W - 1 - p.x : p.x;
      return { x: this.tile / 2 + (jx - ANCHOR.x) * sf, y: this.tile / 2 + (p.y - ANCHOR.y) * sf };
    };
    const bone = (a: JointName, b: JointName) => {
      const p = at(a);
      const q = at(b);
      g.lineStyle(2, 0xff3b6b, 0.95).lineBetween(p.x, p.y, q.x, q.y);
    };
    bone("mainShoulder", "mainHand");
    bone("offShoulder", "offHand");
    bone("nearHip", "nearFoot");
    bone("farHip", "farFoot");
    for (const j of ["mainShoulder", "mainHand", "offShoulder", "offHand", "nearHip", "farHip", "nearFoot", "farFoot"] as const) {
      const p = at(j);
      g.fillStyle(0xffe45e, 1).fillCircle(p.x, p.y, 2.4);
    }
    cell.rig.bringToTop(g);
  }
}

// ── controls UI ─────────────────────────────────────────────────────────────────
// Controls only mutate `controls`; the scene polls `buildSig` each frame and rebuilds
// itself, so there's no scene reference to race with Phaser's deferred boot.

/** Paint one indexed art map onto a fresh pixel-art canvas of the given size. */
function artCanvas(w: number, h: number, art: IndexedSpriteArt | undefined): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  if (art) {
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(w, h);
    blitArt(rgbaSink(img.data, w, h), art, 0, 0);
    ctx.putImageData(img, 0, 0);
  }
  return canvas;
}

/** The item's overworld PNG (`<id>` art) — the same drawing the inventory/world uses. */
function itemIconCanvas(item: string): HTMLCanvasElement {
  return artCanvas(ITEM_ART_W, ITEM_ART_H, ITEM_ART[item]);
}

/** A creature's idle front frame (composed: fill → outline → shadow), for the palette thumbnails. */
function creatureIconCanvas(kind: Kind, style: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_W;
  canvas.height = FRAME_H;
  const fill = AVATAR_FRAME_ART[avatarFrameName(kind, style, "down", "idle")];
  if (fill) {
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(FRAME_W, FRAME_H);
    img.data.set(composeAvatarFrame(fill, fill.outline ?? 0));
    ctx.putImageData(img, 0, 0);
  }
  return canvas;
}

function mountControls() {
  const bar = document.getElementById("controls")!;
  bar.innerHTML = "";

  const group = (label: string) => {
    const g = document.createElement("span");
    g.className = "group";
    if (label) {
      const l = document.createElement("span");
      l.className = "lbl";
      l.textContent = label;
      g.appendChild(l);
    }
    bar.appendChild(g);
    return g;
  };

  const button = (parent: HTMLElement, content: string | Node, active: () => boolean, onClick: () => void) => {
    const b = document.createElement("button");
    if (typeof content === "string") b.textContent = content;
    else b.appendChild(content);
    const refresh = () => b.classList.toggle("on", active());
    b.onclick = () => {
      onClick();
      mountControls(); // rebuild the bar so all `on` states refresh
    };
    refresh();
    parent.appendChild(b);
    return b;
  };

  const views = group("view");
  for (const v of VIEWS) {
    button(views, v, () => controls.view === v, () => {
      controls.view = v;
      if (v === "item" && controls.item === NONE) controls.item = ALL_ITEMS[0] ?? NONE; // item view always shows a real item
    });
  }

  // an inventory-style palette of item slots; hover a slot for its name. "none" (empty-handed)
  // only makes sense for the holder.
  const itemPalette = (label: string, options: string[], current: string, onPick: (id: string) => void) => {
    const pal = document.createElement("div");
    pal.className = "palette";
    for (const id of options) {
      const slot = document.createElement("button");
      slot.type = "button";
      slot.className = "slot" + (id === current ? " selected" : "");
      slot.title = id === NONE ? "None (empty-handed)" : itemName(id);
      if (id === NONE) {
        slot.classList.add("slot-none");
        slot.textContent = "∅";
      } else {
        slot.appendChild(itemIconCanvas(id));
      }
      slot.onclick = () => {
        onPick(id);
        mountControls();
      };
      pal.appendChild(slot);
    }
    group(label).appendChild(pal);
  };

  itemPalette(controls.view === "item" ? "item" : "main hand", controls.view === "item" ? ALL_ITEMS : [NONE, ...ALL_ITEMS], controls.item, (id) => {
    controls.item = id;
  });

  // holder picker (which creature wields) — an inventory-style palette of avatar thumbnails,
  // one per kind×style; only shown for the holder view. Hover a slot for its name.
  if (controls.view === "holder") {
    if (OFF_ITEMS.length > 1) itemPalette("off hand", OFF_ITEMS, controls.offItem, (id) => { controls.offItem = id; });

    const holderGroup = group("holder");
    const holders = document.createElement("div");
    holders.className = "palette";
    CREATURES.forEach((c, i) => {
      const slot = document.createElement("button");
      slot.type = "button";
      slot.className = "slot cslot" + (i === controls.creatureIdx ? " selected" : "");
      slot.title = `${c.style} ${c.kind}`;
      slot.appendChild(creatureIconCanvas(c.kind, c.style));
      slot.onclick = () => {
        controls.creatureIdx = i;
        mountControls();
      };
      holders.appendChild(slot);
    });
    holderGroup.appendChild(holders);

    const modes = group("anim");
    for (const m of MODES) button(modes, m, () => controls.mode === m, () => { controls.mode = m; });

    const play = group("");
    button(play, controls.paused ? "▶ play" : "⏸ pause", () => controls.paused, () => { controls.paused = !controls.paused; });
    button(play, "bones", () => controls.bones, () => { controls.bones = !controls.bones; });
  }

  if (controls.view === "holder" && controls.paused && (controls.mode === "attack" || controls.mode === "auto")) {
    const scrub = group("phase");
    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "1";
    range.step = "0.02";
    range.value = String(controls.scrub);
    range.oninput = () => { controls.scrub = Number(range.value); };
    scrub.appendChild(range);
  }
}

applyUrlControls();
mountControls();

const game = new Phaser.Game({
  type: Phaser.WEBGL,
  parent: "preview",
  backgroundColor: "#0a0806",
  pixelArt: true,
  scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
  input: { windowEvents: false },
  // Keep the drawing buffer so a test can read the rendered pixels back off the canvas.
  render: { preserveDrawingBuffer: true },
});
game.scene.add("preview", PreviewScene, true);
