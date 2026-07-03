import * as THREE from "three";
import { ITEM_3D } from "./palette.js";

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
  return new THREE.MeshStandardMaterial({ color: colour, roughness: 0.85, metalness: 0, flatShading: true });
}

function box(parent: THREE.Object3D, w: number, h: number, d: number, colour: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(colour));
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

function pickaxe(): THREE.Group {
  const g = new THREE.Group();
  box(g, 0.07, 0.62, 0.07, ITEM_3D.wood, 0, 0.16); // haft through the fist
  box(g, 0.5, 0.09, 0.09, ITEM_3D.steel, 0, 0.44); // head
  box(g, 0.1, 0.08, 0.08, ITEM_3D.steelLt, -0.25, 0.44); // picked tips
  box(g, 0.1, 0.08, 0.08, ITEM_3D.steelLt, 0.25, 0.44);
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
  const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 0), mat(ITEM_3D.rock));
  rock.position.y = 0.12;
  rock.castShadow = true;
  g.add(rock);
  const chip = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 0), mat(ITEM_3D.rockLt));
  chip.position.set(0.12, 0.06, 0.05);
  chip.castShadow = true;
  g.add(chip);
  return g;
}

const BUILDERS: Record<string, () => THREE.Group> = { pickaxe, shovel, sword, shield, stone };

export function hasItem3D(item: string): boolean {
  return BUILDERS[item] !== undefined;
}

/** Per-item rest pitch about x, measured from the forearm line: π/2 holds the
 *  business end level in front of the fist; less tips it up ready (sword),
 *  more drops it low (shovel). */
const HELD_PITCH: Record<string, number> = {
  sword: Math.PI / 2 - 0.9, // blade up-forward, at the ready
  pickaxe: Math.PI / 2 - 0.35, // hafted forward, head riding high
  shovel: Math.PI / 2 + 0.25, // blade low, ready to dig
  stone: Math.PI / 2,
};

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
  if (item === "pickaxe") g.rotation.y = Math.PI / 2; // pick tips fore-aft, striking edge forward
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

/** The pushable boulder: a chunky low-poly rock filling most of its tile. */
export function buildBoulder(): THREE.Group {
  const g = new THREE.Group();
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.42, 0), mat(ITEM_3D.rock));
  rock.position.y = 0.36;
  rock.rotation.set(0.4, 0.7, 0.2);
  rock.castShadow = true;
  rock.receiveShadow = true;
  g.add(rock);
  const cap = new THREE.Mesh(new THREE.IcosahedronGeometry(0.18, 0), mat(ITEM_3D.rockLt));
  cap.position.set(0.1, 0.62, -0.05);
  cap.castShadow = true;
  g.add(cap);
  return g;
}
