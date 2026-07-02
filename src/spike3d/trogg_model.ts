import * as THREE from "three";

/**
 * Procedural 3D trogg: the hunched cave ogre built entirely in code — no modelled
 * assets, no editor. The body is a hierarchy of flat-shaded boxes hung off named
 * joint nodes (a Minecraft-style jointed rig rather than a skinned mesh), and the
 * animations are real `AnimationClip`s with keyframe tracks targeting those joint
 * names, played through Three's `AnimationMixer`. That split mirrors the 2D
 * pipeline's philosophy: the *data* (proportions, palette, clips) is authored
 * here as code; the engine machinery (mixing, interpolation, crossfades) is
 * Three's, not ours.
 *
 * Units: 1 unit = 1 tile. The model faces +z at rest; yaw the root to steer.
 */

/** The moss trogg palette, from `TROGG_SKINS` in `tools/art/trogg.ts` (tooling
 *  code stays out of the client bundle, so the values are restated here). */
const MOSS = {
  base: 0x6f8338,
  shade: 0x38481c,
  light: 0xb8bd73,
  muzzle: 0x9ba35a,
  eye: 0xf83820,
  glow: 0xffd048,
  pupil: 0x240804,
  tooth: 0xfff4d8,
} as const;

/** Joint rest pitches (radians): the hunch is part of the skeleton, so every clip
 *  bakes these into its tracks (quaternion tracks replace, not add). */
const REST = {
  torso: 0.14, // hunched forward
  head: -0.1, // skull tips back up a touch so the brow faces out, not down
  arm: 0.08, // arms hang a little proud of the leaning torso
  leg: 0,
} as const;

export interface TroggModel {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: { idle: THREE.AnimationAction; walk: THREE.AnimationAction; run: THREE.AnimationAction; attack: THREE.AnimationAction };
}

const materials = new Map<number, THREE.MeshStandardMaterial>();
function mat(colour: number, emissive = 0): THREE.MeshStandardMaterial {
  const key = colour ^ (emissive << 1);
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.9, metalness: 0, flatShading: true });
    if (emissive) {
      m.emissive = new THREE.Color(emissive);
      m.emissiveIntensity = 0.9;
    }
    materials.set(key, m);
  }
  return m;
}

function box(parent: THREE.Object3D, w: number, h: number, d: number, colour: number, x = 0, y = 0, z = 0, emissive = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(colour, emissive));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function joint(parent: THREE.Object3D, name: string, x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

// ── the body ─────────────────────────────────────────────────────────────────────

function buildBody(): THREE.Group {
  const root = new THREE.Group();
  // `bob` carries the gait's vertical dip so `root` stays free for world placement.
  const bob = joint(root, "bob", 0, 0, 0);

  // legs: short and wide-set, pivoting at the hip
  for (const side of [-1, 1] as const) {
    const leg = joint(bob, side < 0 ? "legL" : "legR", side * 0.2, 0.5, 0);
    leg.rotation.x = REST.leg;
    box(leg, 0.26, 0.32, 0.28, MOSS.base, 0, -0.14); // thigh
    box(leg, 0.2, 0.24, 0.22, MOSS.shade, 0, -0.36); // shin
    box(leg, 0.26, 0.12, 0.36, MOSS.base, 0, -0.46, 0.06); // big three-toed foot
    box(leg, 0.27, 0.05, 0.06, MOSS.shade, 0, -0.5, 0.22); // dark claw gaps
  }

  // torso pivots just above the hips so the hunch and the strike lean read from the waist
  const torso = joint(bob, "torso", 0, 0.55, 0);
  torso.rotation.x = REST.torso;
  box(torso, 0.62, 0.52, 0.46, MOSS.base, 0, 0.26); // belly
  box(torso, 0.46, 0.36, 0.05, MOSS.light, 0, 0.22, 0.22); // lit belly plate
  box(torso, 0.48, 0.04, 0.06, MOSS.shade, 0, 0.14, 0.22); // plate creases
  box(torso, 0.48, 0.04, 0.06, MOSS.shade, 0, 0.28, 0.22);
  box(torso, 0.88, 0.3, 0.5, MOSS.base, 0, 0.62); // hulking shoulder mass
  box(torso, 0.24, 0.1, 0.34, MOSS.light, -0.36, 0.78); // lit shoulder caps
  box(torso, 0.24, 0.1, 0.34, MOSS.light, 0.36, 0.78);

  // arms hang from the shoulder mass; the right arm is the main hand
  for (const side of [-1, 1] as const) {
    const arm = joint(torso, side < 0 ? "armL" : "armR", side * 0.52, 0.62, 0);
    arm.rotation.x = REST.arm;
    box(arm, 0.2, 0.42, 0.22, MOSS.base, 0, -0.2); // upper arm
    box(arm, 0.18, 0.3, 0.2, MOSS.shade, 0, -0.52); // forearm
    box(arm, 0.26, 0.24, 0.26, MOSS.base, 0, -0.74); // heavy fist
  }

  // skull head thrust low and forward between the shoulders
  const head = joint(torso, "head", 0, 1.0, 0.14);
  head.rotation.x = REST.head;
  box(head, 0.52, 0.42, 0.48, MOSS.base, 0, 0.16);
  box(head, 0.42, 0.08, 0.4, MOSS.light, 0, 0.4, -0.02); // lit crown
  box(head, 0.54, 0.08, 0.06, MOSS.shade, 0, 0.22, 0.23); // brow shelf
  box(head, 0.08, 0.07, 0.04, MOSS.eye, -0.13, 0.15, 0.25, MOSS.eye); // sunken glowing eyes
  box(head, 0.08, 0.07, 0.04, MOSS.eye, 0.13, 0.15, 0.25, MOSS.eye);
  box(head, 0.24, 0.12, 0.1, MOSS.muzzle, 0, 0.02, 0.26); // broad flat nose
  box(head, 0.4, 0.09, 0.08, MOSS.shade, 0, -0.09, 0.24); // underbite mouth gap
  box(head, 0.06, 0.13, 0.05, MOSS.tooth, -0.17, -0.05, 0.26); // corner tusks jutting up
  box(head, 0.06, 0.13, 0.05, MOSS.tooth, 0.17, -0.05, 0.26);

  return root;
}

// ── the clips ────────────────────────────────────────────────────────────────────
// Keyframe tracks target the named joints. Rest pitches are baked into every key.

function pitchTrack(node: string, rest: number, times: number[], pitches: number[]): THREE.QuaternionKeyframeTrack {
  const q = new THREE.Quaternion();
  const values: number[] = [];
  for (const p of pitches) {
    q.setFromEuler(new THREE.Euler(rest + p, 0, 0));
    values.push(q.x, q.y, q.z, q.w);
  }
  return new THREE.QuaternionKeyframeTrack(`${node}.quaternion`, times, values);
}

function bobTrack(times: number[], ys: number[]): THREE.VectorKeyframeTrack {
  const values: number[] = [];
  for (const y of ys) values.push(0, y, 0);
  return new THREE.VectorKeyframeTrack("bob.position", times, values);
}

/** A stride loop: legs scissor in opposite phase, arms counter-swing, the body dips
 *  on each footfall — the 3D restatement of the 2D rig's walk/run pose data. */
function gaitClip(name: string, period: number, legSwing: number, armSwing: number, dip: number, lean: number): THREE.AnimationClip {
  const t = [0, period / 4, period / 2, (3 * period) / 4, period];
  return new THREE.AnimationClip(name, period, [
    pitchTrack("legL", REST.leg, t, [legSwing, 0, -legSwing, 0, legSwing]),
    pitchTrack("legR", REST.leg, t, [-legSwing, 0, legSwing, 0, -legSwing]),
    pitchTrack("armL", REST.arm, t, [-armSwing, 0, armSwing, 0, -armSwing]),
    pitchTrack("armR", REST.arm, t, [armSwing, 0, -armSwing, 0, armSwing]),
    pitchTrack("torso", REST.torso, [0, period], [lean, lean]),
    bobTrack(t, [-dip, 0, -dip, 0, -dip]),
  ]);
}

function idleClip(): THREE.AnimationClip {
  const period = 2.6;
  const t = [0, period / 2, period];
  return new THREE.AnimationClip("idle", period, [
    bobTrack(t, [0, -0.015, 0]), // slow breath
    pitchTrack("torso", REST.torso, t, [0, 0.02, 0]),
    pitchTrack("armL", REST.arm, t, [0, 0.04, 0]),
    pitchTrack("armR", REST.arm, t, [0, 0.04, 0]),
  ]);
}

/** The swing: cock the main arm back, throw it forward past horizontal, settle —
 *  the same wind-up → strike → recovery shape as the 2D attack frames. An arm hangs
 *  along −y, so *negative* pitch swings it toward the +z facing. */
function attackClip(): THREE.AnimationClip {
  const dur = 0.32;
  const strike = dur * 0.35; // matches STRIKE_PEAK's quick wind-up, slower recovery
  return new THREE.AnimationClip("attack", dur, [
    pitchTrack("armR", REST.arm, [0, strike * 0.6, strike, dur], [0, 0.9, -1.5, -0.1]),
    pitchTrack("torso", REST.torso, [0, strike * 0.6, strike, dur], [0, -0.06, 0.14, 0.02]),
    bobTrack([0, strike, dur], [0, -0.03, 0]),
  ]);
}

// ── assembly ─────────────────────────────────────────────────────────────────────

export function createTrogg(): TroggModel {
  const root = buildBody();
  const mixer = new THREE.AnimationMixer(root);
  const actions = {
    idle: mixer.clipAction(idleClip()),
    walk: mixer.clipAction(gaitClip("walk", 0.52, 0.55, 0.45, 0.05, 0.02)),
    run: mixer.clipAction(gaitClip("run", 0.34, 0.85, 0.7, 0.08, 0.16)),
    attack: mixer.clipAction(attackClip()),
  };
  actions.attack.setLoop(THREE.LoopOnce, 1);
  return { root, mixer, actions };
}
