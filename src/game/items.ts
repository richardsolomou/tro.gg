import * as THREE from "three";
import { ITEM_3D } from "./palette.js";
import { poolGeometry, poolMaterial } from "./pool.js";

/**
 * Tool, prop, and resource models. A held item is built with its **grip at the
 * origin, business end up (+y)**, then rests in the fist **perpendicular to the
 * forearm** — the way a fist actually grips a haft — tipped by a per-item rest
 * pitch. The rig's hand node doubles as the wrist: attack clips pitch it to aim
 * the business end through each wield's arc (rig.ts), so the one authored pose
 * works on every creature and every weapon class. Ground variants lie the same
 * model down with a little scatter tilt.
 */

function mat(colour: number): THREE.MeshStandardMaterial {
  return poolMaterial(`item:${colour}`, () => new THREE.MeshStandardMaterial({ color: colour, roughness: 0.85, metalness: 0, flatShading: true }));
}

function box(parent: THREE.Object3D, w: number, h: number, d: number, colour: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(poolGeometry(`box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d)), mat(colour));
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

function ico(r: number, detail: number): THREE.BufferGeometry {
  return poolGeometry(`ico:${r}:${detail}`, () => new THREE.IcosahedronGeometry(r, detail));
}

function cone(r: number, h: number, segments: number): THREE.BufferGeometry {
  return poolGeometry(`cone:${r}:${h}:${segments}`, () => new THREE.ConeGeometry(r, h, segments));
}

function cylinder(rTop: number, rBottom: number, h: number, segments: number): THREE.BufferGeometry {
  return poolGeometry(`cyl:${rTop}:${rBottom}:${h}:${segments}`, () => new THREE.CylinderGeometry(rTop, rBottom, h, segments));
}

function pickaxe(): THREE.Group {
  const g = new THREE.Group();
  box(g, 0.07, 0.62, 0.07, ITEM_3D.wood, 0, 0.16); // haft through the fist
  box(g, 0.5, 0.09, 0.09, ITEM_3D.steel, 0, 0.44); // head
  box(g, 0.1, 0.08, 0.08, ITEM_3D.steelLt, -0.25, 0.44); // picked tips
  box(g, 0.1, 0.08, 0.08, ITEM_3D.steelLt, 0.25, 0.44);
  return g;
}

function axe(): THREE.Group {
  const g = new THREE.Group();
  box(g, 0.07, 0.6, 0.07, ITEM_3D.wood, 0, 0.15); // haft through the fist
  box(g, 0.26, 0.2, 0.08, ITEM_3D.steel, 0.1, 0.42); // head
  box(g, 0.06, 0.24, 0.09, ITEM_3D.steelLt, 0.24, 0.42); // bit (the cutting edge)
  return g;
}

function shovel(): THREE.Group {
  const g = new THREE.Group();
  box(g, 0.06, 0.66, 0.06, ITEM_3D.wood, 0, 0.18);
  box(g, 0.18, 0.24, 0.05, ITEM_3D.steel, 0, 0.56); // blade
  box(g, 0.12, 0.06, 0.06, ITEM_3D.woodDk, 0, -0.12); // grip cap
  return g;
}

function sword(): THREE.Group {
  const g = new THREE.Group();
  box(g, 0.07, 0.5, 0.05, ITEM_3D.steel, 0, 0.4); // blade
  box(g, 0.03, 0.5, 0.06, ITEM_3D.steelLt, 0.02, 0.4); // edge highlight
  box(g, 0.24, 0.06, 0.08, ITEM_3D.brass, 0, 0.14); // crossguard
  box(g, 0.07, 0.16, 0.07, ITEM_3D.woodDk, 0, 0.02); // grip
  box(g, 0.1, 0.06, 0.1, ITEM_3D.gold, 0, -0.08); // pommel
  return g;
}

const FLAME_HOT = 0xffe08a;
const FLAME_MID = 0xff8c2e;
const FLAME_DEEP = 0xd94f1e;
/** Cels in the held torch's flame loop (hard-swapped, `steps(1)` style). */
export const TORCH_FLAME_CELS = 6;
/** How long each flame cel holds before the next swaps in. */
export const TORCH_FLAME_CEL_MS = 110;

function flameRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The stylised fire silhouette: a lathed wide-bulge-to-sharp-point profile —
 *  the landing page's flame, at held-item scale. Unlit, so it glows in the dark. */
function flameMat(colour: number): THREE.MeshBasicMaterial {
  return poolMaterial(`flame:${colour}`, () => new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.94 }));
}

function flameBody(colour: number, r: number, h: number): THREE.Mesh {
  const geo = poolGeometry(`flame:${r}:${h}`, () => {
    const profile = [
      [0.001, 0], [0.72, 0.05], [1.0, 0.2], [0.8, 0.44], [0.45, 0.68], [0.16, 0.86], [0.001, 1],
    ].map(([px, py]) => new THREE.Vector2(px! * r, py! * h));
    return new THREE.LatheGeometry(profile, 6);
  });
  return new THREE.Mesh(geo, flameMat(colour));
}

/** One flame cel: the pointed body holds its shape (height jitter, wandering
 *  lean) while a tongue lands somewhere new each frame. */
function flameCel(rand: () => number): THREE.Group {
  const f = new THREE.Group();
  const h = 0.26 + rand() * 0.07;
  const lean = (rand() - 0.5) * 0.3;
  const body = flameBody(FLAME_MID, 0.085, h);
  body.position.y = 0.42;
  body.rotation.z = lean;
  f.add(body);
  const core = flameBody(FLAME_HOT, 0.05, h * 0.62);
  core.position.y = 0.43;
  core.rotation.z = lean * 0.7;
  f.add(core);
  const side = rand() < 0.5 ? -1 : 1;
  const tongue = new THREE.Mesh(cone(0.02 + rand() * 0.01, 0.08 + rand() * 0.05, 4), flameMat(rand() < 0.4 ? FLAME_DEEP : FLAME_MID));
  tongue.position.set(side * (0.05 + rand() * 0.03), 0.52 + rand() * 0.08, 0);
  tongue.rotation.z = -side * (0.25 + rand() * 0.3);
  f.add(tongue);
  return f;
}

function torch(): THREE.Group {
  const g = new THREE.Group();
  box(g, 0.07, 0.46, 0.07, ITEM_3D.wood, 0, 0.1); // haft
  box(g, 0.12, 0.1, 0.12, ITEM_3D.woodDk, 0, 0.36); // pitch-soaked wrap
  const rand = flameRng(0xf1a3);
  const cels = Array.from({ length: TORCH_FLAME_CELS }, () => flameCel(rand));
  for (const cel of cels) {
    cel.visible = false;
    g.add(cel);
  }
  cels[0]!.visible = true;
  // the animate loop hard-swaps these like the landing page's torches
  g.userData.flameCels = cels;
  return g;
}

function shield(): THREE.Group {
  const g = new THREE.Group();
  const face = box(g, 0.4, 0.52, 0.07, ITEM_3D.wood, 0, 0.14, 0.06);
  face.rotation.x = 0.06;
  box(g, 0.4, 0.08, 0.08, ITEM_3D.steel, 0, 0.38, 0.06); // steel rim top
  box(g, 0.1, 0.1, 0.1, ITEM_3D.steel, 0, 0.14, 0.1); // boss
  return g;
}

function stone(): THREE.Group {
  const g = new THREE.Group();
  const rock = new THREE.Mesh(ico(0.16, 0), mat(ITEM_3D.rock));
  rock.position.y = 0.12;
  rock.castShadow = true;
  g.add(rock);
  const chip = new THREE.Mesh(ico(0.08, 0), mat(ITEM_3D.rockLt));
  chip.position.set(0.12, 0.06, 0.05);
  chip.castShadow = true;
  g.add(chip);
  return g;
}

function quill(): THREE.Group {
  const g = new THREE.Group();
  const spine = new THREE.Mesh(cone(0.035, 0.34, 5), mat(ITEM_3D.woodLt));
  spine.position.y = 0.17;
  spine.castShadow = true;
  g.add(spine);
  const tip = new THREE.Mesh(cone(0.02, 0.1, 5), mat(ITEM_3D.woodDk));
  tip.position.y = 0.32;
  g.add(tip);
  return g;
}

function wood(): THREE.Group {
  const g = new THREE.Group();
  const log = new THREE.Mesh(cylinder(0.09, 0.1, 0.4, 6), mat(ITEM_3D.wood));
  log.rotation.z = Math.PI / 2;
  log.position.y = 0.1;
  log.castShadow = true;
  g.add(log);
  const end = new THREE.Mesh(cylinder(0.07, 0.07, 0.02, 6), mat(ITEM_3D.woodLt));
  end.rotation.z = Math.PI / 2;
  end.position.set(0.21, 0.1, 0);
  g.add(end);
  return g;
}

const BUILDERS: Record<string, () => THREE.Group> = { pickaxe, shovel, axe, sword, shield, torch, stone, wood, quill, fine_pickaxe: pickaxe, fine_axe: axe };

export function hasItem3D(item: string): boolean {
  return BUILDERS[item] !== undefined;
}

/** Per-item rest pitch about x, measured from the forearm line: π/2 holds the
 *  business end level in front of the fist; less tips it up ready (sword),
 *  more drops it low (shovel). */
const HELD_PITCH: Record<string, number> = {
  sword: Math.PI / 2 - 0.9, // blade up-forward, at the ready
  pickaxe: Math.PI / 2 - 0.35, // hafted forward, head riding high
  fine_pickaxe: Math.PI / 2 - 0.35,
  axe: Math.PI / 2 - 0.35, // hafted like the pick, bit leading
  fine_axe: Math.PI / 2 - 0.35,
  shovel: Math.PI / 2 + 0.25, // blade low, ready to dig
  torch: 1.25, // cancels the raised-arm pitch so the flame stands vertical
  stone: Math.PI / 2,
  wood: Math.PI / 2,
  quill: Math.PI / 2,
};

/**
 * Live behavior a held item carries with it — the single definition both the
 * game (`entities.ts`) and the dev preview consume, so how an item is held,
 * lit, and animated is authored once, here, per item.
 */
export interface HeldFx {
  /** Flame cels to hard-swap on TORCH_FLAME_CEL_MS. */
  cels?: THREE.Group[];
  /** A light the item sheds. Spawns dark: the game budgets which are lit
   *  (nearest few, like glowmoss); the preview simply turns it on. */
  light?: THREE.PointLight;
  /** Pitch for the holding arm, applied after each mixer update (radians;
   *  negative raises the arm forward-up). */
  armPitch?: number;
}

/** Wire a built held-item model's live behavior; undefined when it has none. */
export function wireHeldFx(item: string, model: THREE.Group): HeldFx | undefined {
  if (item === "torch") {
    const light = new THREE.PointLight(0xff8c2e, 9, 14, 1.6);
    light.position.set(0, 0.5, 0);
    light.visible = false;
    model.add(light);
    return { cels: model.userData.flameCels as THREE.Group[], light, armPitch: -1.25 };
  }
  return undefined;
}

/** Advance a held item's live behavior; call once per frame with `performance.now()`. */
export function updateHeldFx(fx: HeldFx, now: number): void {
  if (fx.cels) {
    const cel = Math.floor(now / TORCH_FLAME_CEL_MS) % fx.cels.length;
    fx.cels.forEach((frame, i) => {
      frame.visible = i === cel;
    });
  }
  if (fx.light?.visible) {
    // two offset sines make the flame breathe without a repeating beat
    fx.light.intensity = 8.6 + Math.sin(now * 0.011) * 1.2 + Math.sin(now * 0.027 + 1.7) * 0.8;
  }
}

/** A held-item model — parent it to a rig hand node. The shield is the exception
 *  to the fist grip: it straps along the forearm, face out, raised into guard. */
export function buildHeldItem(item: string): THREE.Group | undefined {
  const build = BUILDERS[item];
  if (!build) return undefined;
  const g = build();
  if (item === "shield") {
    g.position.set(0, 0.14, 0.02);
    g.rotation.set(0.12, -0.3, 0);
    return g;
  }
  g.rotation.x = HELD_PITCH[item] ?? Math.PI / 2;
  if (item === "pickaxe" || item === "axe" || item === "fine_pickaxe" || item === "fine_axe") g.rotation.y = Math.PI / 2; // striking edge forward
  return g;
}

/** A pickup lying on the floor: the same model tipped over on the ground. */
export function buildGroundItem(item: string): THREE.Group | undefined {
  const build = BUILDERS[item];
  if (!build) return undefined;
  const wrap = new THREE.Group();
  const g = build();
  g.rotation.set(Math.PI / 2 - 0.18, 0, item === "sword" ? 0.7 : -0.4);
  g.position.y = 0.08;
  wrap.add(g);
  return wrap;
}

/** A choppable tree: a squat trunk under stacked low-poly foliage clumps. */
export function buildTree(): THREE.Group {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(cylinder(0.14, 0.2, 0.9, 6), mat(ITEM_3D.woodDk));
  trunk.position.y = 0.45;
  trunk.castShadow = true;
  g.add(trunk);
  const crown = new THREE.Mesh(ico(0.52, 0), mat(ITEM_3D.leaf));
  crown.position.y = 1.25;
  crown.scale.y = 0.85;
  crown.castShadow = true;
  g.add(crown);
  const cap = new THREE.Mesh(ico(0.3, 0), mat(ITEM_3D.leafDk));
  cap.position.set(0.14, 1.68, -0.08);
  cap.castShadow = true;
  g.add(cap);
  return g;
}

/** A hearth's or brazier's flame, cel-animated like a held torch but built at
 *  world scale. Returns the group plus its cels so the caller can hard-swap
 *  them and drive a point light off the same rhythm. */
export function buildFire(seed: number, scale = 1): { group: THREE.Group; cels: THREE.Group[] } {
  const group = new THREE.Group();
  const rand = flameRng(seed);
  const cels = Array.from({ length: TORCH_FLAME_CELS }, () => {
    const cel = flameCel(rand);
    cel.scale.setScalar(scale);
    return cel;
  });
  for (const cel of cels) {
    cel.visible = false;
    group.add(cel);
  }
  cels[0]!.visible = true;
  return { group, cels };
}

/** A hearth or brazier: a stone ring holding the fire (GDD "The fire and the
 *  dark" → Territory and permanence). The flame and its light are wired
 *  separately (`buildFire`/`wireBrazierFx`) so the caller can drive both off
 *  the same `lit` state. */
export function buildBrazier(): THREE.Group {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(cylinder(0.5, 0.56, 0.22, 8), mat(ITEM_3D.rockDk));
  ring.position.y = 0.11;
  ring.castShadow = true;
  ring.receiveShadow = true;
  g.add(ring);
  const bed = new THREE.Mesh(cylinder(0.4, 0.4, 0.1, 8), mat(ITEM_3D.rock));
  bed.position.y = 0.2;
  g.add(bed);
  const { group: fire, cels } = buildFire(0x8110, 1.8);
  fire.position.y = 0.24;
  g.add(fire);
  g.userData.flameCels = cels;
  return g;
}

/** The mineable boulder: a chunky low-poly rock filling most of its tile. */
export function buildBoulder(): THREE.Group {
  const g = new THREE.Group();
  const rock = new THREE.Mesh(poolGeometry("dodeca:0.42", () => new THREE.DodecahedronGeometry(0.42, 0)), mat(ITEM_3D.rock));
  rock.position.y = 0.36;
  rock.rotation.set(0.4, 0.7, 0.2);
  rock.castShadow = true;
  rock.receiveShadow = true;
  g.add(rock);
  const cap = new THREE.Mesh(ico(0.18, 0), mat(ITEM_3D.rockLt));
  cap.position.set(0.1, 0.62, -0.05);
  cap.castShadow = true;
  g.add(cap);
  return g;
}
