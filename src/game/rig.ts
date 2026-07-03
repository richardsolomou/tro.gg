import * as THREE from "three";
import type { Wield } from "@trogg/shared";

/**
 * The creature rig: jointed box models on named nodes, animated by real
 * `AnimationClip`s through Three's `AnimationMixer` — the engine does the mixing
 * and crossfades; the *data* (proportions, palettes, clip amplitudes) is
 * authored in code. No modelled assets, no editor files.
 *
 * Shared joint vocabulary (every creature): `Bob` (gait dip), `LegL`/`LegR`,
 * `Torso`, `ArmL`/`ArmR`, `Head`, plus the equip attach nodes `HandR`/`HandL` —
 * the cross-species slot contract (`mainHand` is the right hand, `offHand` the
 * left), so any held item can pin to any creature.
 *
 * Units: 1 unit = 1 tile. Models face +z at rest; yaw the root to steer.
 */

/** Stride periods: at 4 tiles/s walking, a footfall lands about every half tile. */
export const WALK_PERIOD = 0.5;
export const RUN_PERIOD = 0.32;
/** Attack clip length — matches the synced EQUIPMENT_ACTION_MS use impulse. */
export const ATTACK_PERIOD = 0.3;

/** One gait as two layers: `legs` (legs + bob) keeps striding through an attack,
 *  while `arms` (arms + torso) is what the attack clip replaces. */
export interface GaitActions {
  legs: THREE.AnimationAction;
  arms: THREE.AnimationAction;
}

export interface CreatureModel {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: { idle: GaitActions; walk: GaitActions; run: GaitActions; attacks: Record<Wield, THREE.AnimationAction> };
  /** Every material on this instance, for the hit flash. */
  materials: THREE.MeshStandardMaterial[];
  /** Equip attach nodes: items parented here ride the animated arm. */
  handR: THREE.Group;
  handL: THREE.Group;
  /** Top of the head in model units — where labels/bubbles/carries hang. */
  height: number;
  /** Scale for held-item models, so every species grips gear sized to its fist. */
  fit: number;
  /** Turn the solid-white hit flash on or off. */
  flash(on: boolean): void;
}

/** A model under construction: geometry helpers plus the per-instance material list. */
export class Parts {
  readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly tint?: THREE.Color;

  constructor(tint?: number) {
    // The per-player colour rides as a multiply over the whole body.
    this.tint = tint === undefined ? undefined : new THREE.Color(tint);
  }

  mat(colour: number, emissive = false): THREE.MeshStandardMaterial {
    const c = new THREE.Color(colour);
    if (this.tint) c.multiply(this.tint);
    const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, metalness: 0, flatShading: true });
    if (emissive) {
      m.emissive.copy(c);
      m.emissiveIntensity = 0.9;
    }
    this.materials.push(m);
    return m;
  }

  box(parent: THREE.Object3D, w: number, h: number, d: number, colour: number, x = 0, y = 0, z = 0, emissive = false): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.mat(colour, emissive));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

  /** A flat-shaded coarse sphere — the low-poly blob for round bodies and rocks. */
  blob(parent: THREE.Object3D, r: number, colour: number, x = 0, y = 0, z = 0, scaleY = 1, detail = 1): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(r, detail), this.mat(colour));
    mesh.position.set(x, y, z);
    mesh.scale.y = scaleY;
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

  cone(parent: THREE.Object3D, r: number, h: number, colour: number, x = 0, y = 0, z = 0, segments = 6): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.ConeGeometry(r, h, segments), this.mat(colour));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }
}

export function joint(parent: THREE.Object3D, name: string, x: number, y: number, z: number, pitch = 0): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  g.rotation.x = pitch;
  parent.add(g);
  return g;
}

// ── clips ────────────────────────────────────────────────────────────────────────

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
  return new THREE.VectorKeyframeTrack("Bob.position", times, values);
}

/** Per-species animation amplitudes. Rest pitches are baked into every key
 *  (quaternion tracks replace rotation, they don't add). */
export interface GaitSpec {
  restTorso: number;
  restArm: number;
  legSwing: number;
  armSwing: number;
  walkDip: number;
  runDip: number;
  runLean: number;
  /** Breathing depth at idle. */
  breathe: number;
}

/** A stride's lower layer: legs scissor in opposite phase, the body dips on each
 *  footfall. Runs even through an attack, so the feet never freeze mid-stride. */
function gaitLegsClip(name: string, period: number, s: GaitSpec, scale: number, dip: number): THREE.AnimationClip {
  const t = [0, period / 4, period / 2, (3 * period) / 4, period];
  const leg = s.legSwing * scale;
  return new THREE.AnimationClip(`${name}-legs`, period, [
    pitchTrack("LegL", 0, t, [leg, 0, -leg, 0, leg]),
    pitchTrack("LegR", 0, t, [-leg, 0, leg, 0, -leg]),
    bobTrack(t, [-dip, 0, -dip, 0, -dip]),
  ]);
}

/** A stride's upper layer: arms counter-swing over the torso lean. The attack
 *  clips replace exactly this layer. */
function gaitArmsClip(name: string, period: number, s: GaitSpec, scale: number, lean: number): THREE.AnimationClip {
  const t = [0, period / 4, period / 2, (3 * period) / 4, period];
  const arm = s.armSwing * scale;
  return new THREE.AnimationClip(`${name}-arms`, period, [
    pitchTrack("ArmL", s.restArm, t, [-arm, 0, arm, 0, -arm]),
    pitchTrack("ArmR", s.restArm, t, [arm, 0, -arm, 0, arm]),
    pitchTrack("Torso", s.restTorso, [0, period], [lean, lean]),
  ]);
}

const IDLE_PERIOD = 2.6;

function idleLegsClip(s: GaitSpec): THREE.AnimationClip {
  const t = [0, IDLE_PERIOD / 2, IDLE_PERIOD];
  return new THREE.AnimationClip("idle-legs", IDLE_PERIOD, [bobTrack(t, [0, -s.breathe, 0])]);
}

function idleArmsClip(s: GaitSpec): THREE.AnimationClip {
  const t = [0, IDLE_PERIOD / 2, IDLE_PERIOD];
  return new THREE.AnimationClip("idle-arms", IDLE_PERIOD, [
    pitchTrack("Torso", s.restTorso, t, [0, 0.02, 0]),
    pitchTrack("ArmL", s.restArm, t, [0, 0.04, 0]),
    pitchTrack("ArmR", s.restArm, t, [0, 0.04, 0]),
  ]);
}

/** The per-wield attack clips. Every clip is wind-up → strike (at ~35%) → recovery
 *  over the same ATTACK_PERIOD, so any of them stays timed to the synced
 *  equipment-use impulse. An arm hangs along −y, so *negative* arm pitch swings it
 *  toward the +z facing; the hand node doubles as a wrist, whose pitch tips the
 *  held item relative to the forearm (items rest perpendicular to it, see
 *  items.ts) — arm carries the blow, wrist aims the business end.
 *  All amplitudes ride the species' GaitSpec rests, so one authored clip per
 *  weapon class fits every creature that implements the joint vocabulary. */
function attackClip(name: Wield, s: GaitSpec, strikeAt: number, tracks: (t: number[]) => THREE.KeyframeTrack[]): THREE.AnimationClip {
  const strike = ATTACK_PERIOD * strikeAt;
  return new THREE.AnimationClip(name, ATTACK_PERIOD, tracks([0, strike * 0.6, strike, ATTACK_PERIOD]));
}

function attackClips(s: GaitSpec): Record<Wield, THREE.AnimationClip> {
  return {
    // bare-fisted haymaker: cock back, throw forward past horizontal
    swing: attackClip("swing", s, 0.35, (t) => [
      pitchTrack("ArmR", s.restArm, t, [0, 0.9, -1.5, -0.1]),
      pitchTrack("Torso", s.restTorso, t, [0, -0.06, 0.14, 0.02]),
    ]),
    // sword thrust: draw back at the waist, lunge with the blade level along the arm
    stab: attackClip("stab", s, 0.35, (t) => [
      pitchTrack("ArmR", s.restArm, t, [0, 0.55, -1.5, -0.15]),
      pitchTrack("HandR", 0, t, [0, 0.6, 2.45, 0.15]),
      pitchTrack("Torso", s.restTorso, t, [0, -0.08, 0.18, 0.02]),
    ]),
    // pickaxe chop: haul overhead behind the shoulder, slam down in front
    chop: attackClip("chop", s, 0.4, (t) => [
      pitchTrack("ArmR", s.restArm, t, [0, -2.4, -0.8, -0.1]),
      pitchTrack("HandR", 0, t, [0, 1.64, 2.04, 0.1]),
      pitchTrack("Torso", s.restTorso, t, [0, -0.14, 0.2, 0.02]),
    ]),
    // shovel scoop: bow into a low dig, then heave the blade up over the shoulder
    scoop: attackClip("scoop", s, 0.4, (t) => [
      pitchTrack("ArmR", s.restArm, t, [0.35, -0.85, -1.6, -0.1]),
      pitchTrack("HandR", 0, t, [0.15, 1.79, 0.94, 0.05]),
      pitchTrack("Torso", s.restTorso, t, [0.02, 0.24, -0.1, 0.02]),
    ]),
  };
}

/** Wrap a built body in the animation machinery: mixer, the standard actions
 *  (gaits plus one attack per wield class), and the white hit flash over this
 *  instance's materials. `fit` scales held items to the species' fist. */
export function finishCreature(root: THREE.Group, parts: Parts, spec: GaitSpec, height: number, fit = 1): CreatureModel {
  const mixer = new THREE.AnimationMixer(root);
  const attacks = Object.fromEntries(
    Object.entries(attackClips(spec)).map(([wield, clip]) => {
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      return [wield, action];
    }),
  ) as Record<Wield, THREE.AnimationAction>;
  const gait = (name: string, period: number, scale: number, dip: number, lean: number): GaitActions => ({
    legs: mixer.clipAction(gaitLegsClip(name, period, spec, scale, dip)),
    arms: mixer.clipAction(gaitArmsClip(name, period, spec, scale, lean)),
  });
  const actions = {
    idle: { legs: mixer.clipAction(idleLegsClip(spec)), arms: mixer.clipAction(idleArmsClip(spec)) },
    walk: gait("walk", WALK_PERIOD, 1, spec.walkDip, 0),
    run: gait("run", RUN_PERIOD, 1.55, spec.runDip, spec.runLean),
    attacks,
  };
  const handR = (root.getObjectByName("HandR") as THREE.Group | undefined) ?? new THREE.Group();
  const handL = (root.getObjectByName("HandL") as THREE.Group | undefined) ?? new THREE.Group();
  const saved = parts.materials.map((m) => ({ emissive: m.emissive.clone(), intensity: m.emissiveIntensity }));
  const flash = (on: boolean) => {
    parts.materials.forEach((m, i) => {
      if (on) {
        m.emissive.set(0xffffff);
        m.emissiveIntensity = 1;
      } else {
        m.emissive.copy(saved[i]!.emissive);
        m.emissiveIntensity = saved[i]!.intensity;
      }
    });
  };
  return { root, mixer, actions, materials: parts.materials, handR, handL, height, fit, flash };
}
