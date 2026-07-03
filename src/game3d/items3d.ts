import * as THREE from "three";
import { ITEM_3D } from "./palette.js";

/**
 * Tool, prop, and resource models. A held item is built with its **grip at the
 * origin, business end up (+y)** so that parented to a rig hand node it stands in
 * the fist at rest and swings forward with the arm's attack pitch — the 3D
 * restatement of the 2D "authored once, rides the hand joint" rule. Ground
 * variants lie the same model down with a little scatter tilt.
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

/** Per-item rest tilt in the fist (radians about x, on top of the carry flip):
 *  tools rest tipped a touch; the shield stays flat against the forearm. */
const HELD_PITCH: Record<string, number> = { pickaxe: 0.35, shovel: 0.3, sword: 0.15, shield: 0 };

/** A held-item model — parent it to a rig hand node. The hand hangs at the end of
 *  the arm, so the model is flipped to extend *away* from the limb (business end
 *  toward the ground at rest); when the attack pitches the arm forward past
 *  horizontal, the same flip makes the business end lead the strike. The shield is
 *  the exception: it stays upright, flat along the forearm. */
export function buildHeldItem(item: string): THREE.Group | undefined {
  const build = BUILDERS[item];
  if (!build) return undefined;
  const g = build();
  g.rotation.x = item === "shield" ? 0 : Math.PI - (HELD_PITCH[item] ?? 0);
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
