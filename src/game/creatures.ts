import * as THREE from "three";
import { GHOST_3D, TROGG_SKINS_3D } from "./palette.js";
import { finishCreature, joint, Parts, type CreatureModel, type GaitSpec } from "./rig.js";

/**
 * Every creature body, built procedurally on the shared joint vocabulary
 * (`rig.ts`). Proportions follow the concept art (`docs/art-refs/`).
 * Model style notes live with each builder; palettes in `palette.ts`.
 */

const TROGG_GAIT: GaitSpec = { restTorso: 0.14, restArm: 0.08, legSwing: 0.55, armSwing: 0.45, walkDip: 0.05, runDip: 0.08, runLean: 0.16, breathe: 0.015 };

/** The hunched cave ogre (styles: moss/stone/ridge; `tint` is the player colour). */
export function buildTrogg(style: string, tint?: number): CreatureModel {
  const skin = TROGG_SKINS_3D[style] ?? TROGG_SKINS_3D.moss!;
  const p = new Parts(tint);
  const root = new THREE.Group();
  const bob = joint(root, "Bob", 0, 0, 0);

  for (const side of [-1, 1] as const) {
    const leg = joint(bob, side < 0 ? "LegL" : "LegR", side * 0.2, 0.5, 0);
    p.box(leg, 0.26, 0.32, 0.28, skin.base, 0, -0.14);
    p.box(leg, 0.2, 0.24, 0.22, skin.shade, 0, -0.36);
    p.box(leg, 0.26, 0.12, 0.36, skin.base, 0, -0.46, 0.06); // big three-toed foot
    p.box(leg, 0.27, 0.05, 0.06, skin.shade, 0, -0.5, 0.22); // claw gaps
  }

  const torso = joint(bob, "Torso", 0, 0.55, 0, TROGG_GAIT.restTorso);
  p.box(torso, 0.62, 0.52, 0.46, skin.base, 0, 0.26); // belly
  p.box(torso, 0.46, 0.36, 0.05, skin.light, 0, 0.22, 0.22); // lit belly plate
  p.box(torso, 0.48, 0.04, 0.06, skin.shade, 0, 0.14, 0.22); // plate creases
  p.box(torso, 0.48, 0.04, 0.06, skin.shade, 0, 0.28, 0.22);
  p.box(torso, 0.88, 0.3, 0.5, skin.base, 0, 0.62); // hulking shoulder mass
  p.box(torso, 0.24, 0.1, 0.34, skin.light, -0.36, 0.78); // lit shoulder caps
  p.box(torso, 0.24, 0.1, 0.34, skin.light, 0.36, 0.78);

  for (const side of [-1, 1] as const) {
    const arm = joint(torso, side < 0 ? "ArmL" : "ArmR", side * 0.52, 0.62, 0, TROGG_GAIT.restArm);
    p.box(arm, 0.2, 0.42, 0.22, skin.base, 0, -0.2);
    p.box(arm, 0.18, 0.3, 0.2, skin.shade, 0, -0.52);
    p.box(arm, 0.26, 0.24, 0.26, skin.base, 0, -0.74); // heavy fist
    joint(arm, side < 0 ? "HandL" : "HandR", 0, -0.78, 0.08);
  }

  const head = joint(torso, "Head", 0, 1.0, 0.14, -0.1);
  p.box(head, 0.52, 0.42, 0.48, skin.base, 0, 0.16);
  p.box(head, 0.42, 0.08, 0.4, skin.light, 0, 0.4, -0.02); // lit crown
  p.box(head, 0.54, 0.08, 0.06, skin.shade, 0, 0.22, 0.23); // brow shelf
  if (skin.ridge) {
    p.box(head, 0.1, 0.08, 0.08, skin.light, -0.15, 0.3, 0.22); // bony brow bumps
    p.box(head, 0.1, 0.08, 0.08, skin.light, 0.15, 0.3, 0.22);
  }
  p.box(head, 0.08, 0.07, 0.04, skin.eye, -0.13, 0.15, 0.25, true); // sunken glowing eyes
  p.box(head, 0.08, 0.07, 0.04, skin.eye, 0.13, 0.15, 0.25, true);
  p.box(head, 0.24, 0.12, 0.1, skin.muzzle, 0, 0.02, 0.26); // broad flat nose
  p.box(head, 0.4, 0.09, 0.08, skin.shade, 0, -0.09, 0.24); // underbite mouth gap
  p.box(head, 0.06, 0.13, 0.05, skin.tooth, -0.17, -0.05, 0.26); // corner tusks
  p.box(head, 0.06, 0.13, 0.05, skin.tooth, 0.17, -0.05, 0.26);

  return finishCreature(root, p, TROGG_GAIT, 1.75);
}

/** The pale draped ghost (cosmetic easter egg): a sheet dome, eye holes, stub feet. */
export function buildGhost(): THREE.Group {
  const g = GHOST_3D;
  const root = new THREE.Group();
  const sheet = new THREE.MeshStandardMaterial({ color: g.sheet, roughness: 0.9, flatShading: true, transparent: true, opacity: 0.92 });
  const dome = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.0, 9), sheet);
  dome.position.y = 0.62;
  dome.castShadow = true;
  root.add(dome);
  const headCap = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1), sheet);
  headCap.position.y = 1.05;
  root.add(headCap);
  const dark = new THREE.MeshStandardMaterial({ color: g.eye, roughness: 1 });
  for (const side of [-1, 1] as const) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, 0.03), dark);
    eye.position.set(side * 0.11, 1.02, 0.27);
    root.add(eye);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.14), new THREE.MeshStandardMaterial({ color: g.foot, roughness: 1 }));
    foot.position.set(side * 0.14, 0.05, 0.05);
    root.add(foot);
  }
  return root;
}
