import * as THREE from "three";
import { BUFF_3D, CHICK_3D, DINO_3D, GHOST_3D, HOG_SKINS_3D, TROGG_SKINS_3D, type HogSkin3D } from "./palette.js";
import { finishCreature, joint, Parts, type CreatureModel, type GaitSpec } from "./rig3d.js";

/**
 * Every creature body, built procedurally on the shared joint vocabulary
 * (`rig3d.ts`). Proportions echo the 2D silhouettes: the hunched big-shouldered
 * trogg, the round quilled hog, the swole buff, the dino costume, the chicken.
 * Model style notes live with each builder; palettes in `palette.ts`.
 */

const TROGG_GAIT: GaitSpec = { restTorso: 0.14, restArm: 0.08, legSwing: 0.55, armSwing: 0.45, walkDip: 0.05, runDip: 0.08, runLean: 0.16, breathe: 0.015 };
const HOG_GAIT: GaitSpec = { restTorso: 0.06, restArm: 0.12, legSwing: 0.4, armSwing: 0.3, walkDip: 0.03, runDip: 0.05, runLean: 0.08, breathe: 0.012 };

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

/** The round quilled hedgehog shared by classic/snow/ember. */
function buildCommonHog(skin: HogSkin3D): CreatureModel {
  const p = new Parts();
  const root = new THREE.Group();
  const bob = joint(root, "Bob", 0, 0, 0);

  for (const side of [-1, 1] as const) {
    const leg = joint(bob, side < 0 ? "LegL" : "LegR", side * 0.14, 0.2, 0);
    p.box(leg, 0.14, 0.16, 0.16, skin.limb, 0, -0.12);
  }

  const torso = joint(bob, "Torso", 0, 0.22, 0, HOG_GAIT.restTorso);
  // quill mantle: a shaggy back dome of cones over the body blob
  p.blob(torso, 0.42, skin.quill, 0, 0.34, -0.06, 0.95);
  const spikes = 10;
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI; // over the crown, front to back
    const r = 0.4;
    p.cone(torso, 0.07, 0.2, i % 2 === 0 ? skin.quill : skin.quillDk, Math.cos(a) * r * 0.9, 0.36 + Math.sin(a) * r * 0.8, -0.1 - Math.sin(a) * 0.18, 5).rotation.set(-Math.PI / 2 + Math.sin(a), 0, Math.cos(a) * 0.8);
  }
  // cream face/belly toward the front
  p.blob(torso, 0.3, skin.face, 0, 0.28, 0.2, 0.95);
  for (const side of [-1, 1] as const) {
    const arm = joint(torso, side < 0 ? "ArmL" : "ArmR", side * 0.24, 0.26, 0.16, HOG_GAIT.restArm);
    p.box(arm, 0.1, 0.16, 0.1, skin.face, 0, -0.08);
    joint(arm, side < 0 ? "HandL" : "HandR", 0, -0.14, 0.04);
  }
  const head = joint(torso, "Head", 0, 0.52, 0.2);
  p.blob(head, 0.06, skin.face, -0.16, 0.14, 0); // ears
  p.blob(head, 0.06, skin.face, 0.16, 0.14, 0);
  p.box(head, 0.05, 0.07, 0.03, skin.eye, -0.1, 0.02, 0.22);
  p.box(head, 0.05, 0.07, 0.03, skin.eye, 0.1, 0.02, 0.22);
  p.box(head, 0.09, 0.07, 0.06, skin.nose, 0, -0.06, 0.24); // little snout
  return finishCreature(root, p, HOG_GAIT, 0.95);
}

/** The swole showpiece: tan muscle, quill mane, smug face. Rendered 2× by hogSize. */
function buildBuff(): CreatureModel {
  const c = BUFF_3D;
  const p = new Parts();
  const root = new THREE.Group();
  const bob = joint(root, "Bob", 0, 0, 0);
  for (const side of [-1, 1] as const) {
    const leg = joint(bob, side < 0 ? "LegL" : "LegR", side * 0.18, 0.34, 0);
    p.box(leg, 0.2, 0.24, 0.22, c.skin, 0, -0.12);
    p.box(leg, 0.22, 0.1, 0.28, c.skinDk, 0, -0.28, 0.03);
  }
  const torso = joint(bob, "Torso", 0, 0.36, 0, 0.05);
  p.box(torso, 0.7, 0.55, 0.44, c.skin, 0, 0.28); // barrel chest
  p.box(torso, 0.26, 0.16, 0.06, c.skinHi, -0.16, 0.42, 0.21); // pecs
  p.box(torso, 0.26, 0.16, 0.06, c.skinHi, 0.16, 0.42, 0.21);
  p.box(torso, 0.4, 0.04, 0.05, c.skinDk, 0, 0.28, 0.22); // ab lines
  p.box(torso, 0.4, 0.04, 0.05, c.skinDk, 0, 0.16, 0.22);
  for (const side of [-1, 1] as const) {
    const arm = joint(torso, side < 0 ? "ArmL" : "ArmR", side * 0.44, 0.5, 0, 0.12);
    p.blob(arm, 0.14, c.skin, 0, -0.02, 0); // deltoid
    p.box(arm, 0.18, 0.34, 0.2, c.skin, 0, -0.22);
    p.box(arm, 0.2, 0.18, 0.22, c.skinDk, 0, -0.48); // fist
    joint(arm, side < 0 ? "HandL" : "HandR", 0, -0.52, 0.06);
  }
  const head = joint(torso, "Head", 0, 0.68, 0.06);
  p.blob(head, 0.26, c.quill, 0, 0.22, -0.06, 0.8); // mane crown
  for (let i = -2; i <= 2; i++) p.cone(head, 0.06, 0.16, c.quillDk, i * 0.11, 0.36, -0.08, 5);
  p.box(head, 0.3, 0.24, 0.24, c.face, 0, 0.08, 0.12); // smug face
  p.box(head, 0.05, 0.06, 0.03, c.eye, -0.08, 0.12, 0.25);
  p.box(head, 0.05, 0.06, 0.03, c.eye, 0.08, 0.12, 0.25);
  p.box(head, 0.07, 0.05, 0.04, c.nose, 0, 0.02, 0.25);
  return finishCreature(root, p, { ...HOG_GAIT, restTorso: 0.05, legSwing: 0.45, armSwing: 0.4 }, 1.25);
}

/** The T-rex costume: green scales, toothy hood, back ridge, tail. Rendered 2×. */
function buildDino(): CreatureModel {
  const c = DINO_3D;
  const p = new Parts();
  const root = new THREE.Group();
  const bob = joint(root, "Bob", 0, 0, 0);
  for (const side of [-1, 1] as const) {
    const leg = joint(bob, side < 0 ? "LegL" : "LegR", side * 0.17, 0.3, 0);
    p.box(leg, 0.2, 0.22, 0.22, c.body, 0, -0.1);
    p.box(leg, 0.22, 0.1, 0.28, c.bodyDk, 0, -0.24, 0.03);
  }
  const torso = joint(bob, "Torso", 0, 0.32, 0, 0.08);
  p.blob(torso, 0.4, c.body, 0, 0.3, 0, 1.05); // round costume body
  p.blob(torso, 0.26, c.belly, 0, 0.24, 0.2, 1.1); // cream belly
  const tail = p.box(torso, 0.18, 0.16, 0.5, c.body, 0, 0.12, -0.5);
  tail.rotation.x = 0.5;
  for (let i = 0; i < 4; i++) p.cone(torso, 0.06, 0.14, c.bodyDk, 0, 0.6 - i * 0.16, -0.28 - i * 0.1, 4); // back ridge
  for (const side of [-1, 1] as const) {
    const arm = joint(torso, side < 0 ? "ArmL" : "ArmR", side * 0.34, 0.4, 0.14, 0.15);
    p.box(arm, 0.1, 0.2, 0.1, c.body, 0, -0.1);
    joint(arm, side < 0 ? "HandL" : "HandR", 0, -0.18, 0.04);
  }
  const head = joint(torso, "Head", 0, 0.66, 0.1);
  p.blob(head, 0.3, c.body, 0, 0.16, 0.04, 0.9); // hood
  p.box(head, 0.3, 0.12, 0.3, c.body, 0, 0.06, 0.2); // snout over the opening
  for (let i = -2; i <= 2; i++) p.box(head, 0.05, 0.09, 0.04, c.tooth, i * 0.09, 0.0, 0.32); // teeth fringe
  p.box(head, 0.06, 0.06, 0.04, c.eye, -0.12, 0.26, 0.26); // costume eyes high on the snout
  p.box(head, 0.06, 0.06, 0.04, c.eye, 0.12, 0.26, 0.26);
  p.box(head, 0.22, 0.16, 0.12, c.face, 0, -0.02, 0.16); // hog face inside the mouth
  p.box(head, 0.04, 0.05, 0.03, c.eye, -0.06, 0.0, 0.23);
  p.box(head, 0.04, 0.05, 0.03, c.eye, 0.06, 0.0, 0.23);
  return finishCreature(root, p, { ...HOG_GAIT, restTorso: 0.08 }, 1.3);
}

/** The chicken costume easter egg: cream body, flapping wings, comb, beak. */
function buildChicken(): CreatureModel {
  const c = CHICK_3D;
  const p = new Parts();
  const root = new THREE.Group();
  const bob = joint(root, "Bob", 0, 0, 0);
  for (const side of [-1, 1] as const) {
    const leg = joint(bob, side < 0 ? "LegL" : "LegR", side * 0.12, 0.18, 0);
    p.box(leg, 0.08, 0.14, 0.08, c.beak, 0, -0.08);
    p.box(leg, 0.12, 0.04, 0.16, c.beak, 0, -0.16, 0.03);
  }
  const torso = joint(bob, "Torso", 0, 0.2, 0, 0.04);
  p.blob(torso, 0.36, c.body, 0, 0.3, 0, 1);
  p.blob(torso, 0.12, c.tail, 0, 0.42, -0.34); // russet tail
  // wings hang on the arm joints so they flap with the gait
  for (const side of [-1, 1] as const) {
    const arm = joint(torso, side < 0 ? "ArmL" : "ArmR", side * 0.34, 0.36, 0, 0.2);
    p.box(arm, 0.08, 0.28, 0.22, c.bodyDk, side * 0.02, -0.12, 0);
    joint(arm, side < 0 ? "HandL" : "HandR", 0, -0.2, 0.04);
  }
  const head = joint(torso, "Head", 0, 0.6, 0.06);
  p.blob(head, 0.2, c.body, 0, 0.1, 0);
  for (let i = -1; i <= 1; i++) p.blob(head, 0.06, c.comb, i * 0.08, 0.3 + (i === 0 ? 0.03 : 0), 0); // comb
  p.box(head, 0.16, 0.12, 0.1, c.face, 0, 0.06, 0.16); // hog face under the beak
  p.box(head, 0.04, 0.05, 0.03, c.eye, -0.05, 0.09, 0.22);
  p.box(head, 0.04, 0.05, 0.03, c.eye, 0.05, 0.09, 0.22);
  p.cone(head, 0.06, 0.14, c.beak, 0, 0.0, 0.24, 4).rotation.x = Math.PI / 2; // beak
  return finishCreature(root, p, { ...HOG_GAIT, armSwing: 0.5 }, 1.0);
}

/** Which builder makes a hog style's body. */
export function buildHog(style: string): CreatureModel {
  if (style === "buff") return buildBuff();
  if (style === "dino") return buildDino();
  if (style === "chicken") return buildChicken();
  return buildCommonHog(HOG_SKINS_3D[style] ?? HOG_SKINS_3D.classic!);
}

/** The defensive curl: a static spiky ball with the face tucked at the front —
 *  what a carried hog renders as (GDD "Hog ball form"). No rig; one pose. */
export function buildHogBall(style: string): THREE.Group {
  const skin = HOG_SKINS_3D[style] ?? HOG_SKINS_3D.classic!;
  const p = new Parts();
  const root = new THREE.Group();
  p.blob(root, 0.34, skin.quill, 0, 0, 0);
  const n = 14;
  for (let i = 0; i < n; i++) {
    // spikes bristling all the way round (golden-angle spread, deterministic)
    const a = i * 2.399963;
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const dir = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
    if (dir.z > 0.8) continue; // leave the face clear
    const spike = p.cone(root, 0.06, 0.18, i % 2 === 0 ? skin.quill : skin.quillDk, dir.x * 0.32, dir.y * 0.32, dir.z * 0.32, 5);
    spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  }
  p.blob(root, 0.16, skin.face, 0, -0.06, 0.24); // buried cream face
  p.box(root, 0.07, 0.05, 0.04, skin.nose, 0, -0.08, 0.4);
  return root;
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
