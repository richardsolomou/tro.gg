import * as THREE from "three";

/**
 * The 3D creature rig: jointed box models on named nodes, animated by real
 * `AnimationClip`s through Three's `AnimationMixer` — the engine does the mixing
 * and crossfades; the *data* (proportions, palettes, clip amplitudes) is authored
 * in code, mirroring the 2D pipeline's assets-as-code philosophy.
 *
 * Shared joint vocabulary (every creature): `Bob` (gait dip), `LegL`/`LegR`,
 * `Torso`, `ArmL`/`ArmR`, `Head`, plus the equip attach nodes `HandR`/`HandL` —
 * the 3D restatement of the 2D rig's cross-species slot contract (`mainHand` is
 * the right hand, `offHand` the left), so any held item can pin to any creature.
 *
 * Units: 1 unit = 1 tile. Models face +z at rest; yaw the root to steer.
 */

/** Gait timing shared with the 2D client's phase lengths (WALK/RUN_PHASE_MS × 4). */
export const WALK_PERIOD = 0.5;
export const RUN_PERIOD = 0.32;
/** Attack clip length — matches the 2D EQUIPMENT_ACTION_MS impulse. */
export const ATTACK_PERIOD = 0.3;

export interface CreatureModel {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: { idle: THREE.AnimationAction; walk: THREE.AnimationAction; run: THREE.AnimationAction; attack: THREE.AnimationAction };
  /** Every material on this instance, for the hit flash. */
  materials: THREE.MeshStandardMaterial[];
  /** Equip attach nodes: items parented here ride the animated arm. */
  handR: THREE.Group;
  handL: THREE.Group;
  /** Top of the head in model units — where labels/bubbles/carries hang. */
  height: number;
  /** Turn the solid-white hit flash on or off. */
  flash(on: boolean): void;
}

/** A model under construction: geometry helpers plus the per-instance material list. */
export class Parts {
  readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly tint?: THREE.Color;

  constructor(tint?: number) {
    // The per-player colour rides as a multiply over the whole body, like the 2D sprite tint.
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

/** A stride loop: legs scissor in opposite phase, arms counter-swing, the body dips
 *  on each footfall — the 3D restatement of the 2D rig's gait pose data. */
function gaitClip(name: string, period: number, s: GaitSpec, scale: number, dip: number, lean: number): THREE.AnimationClip {
  const t = [0, period / 4, period / 2, (3 * period) / 4, period];
  const leg = s.legSwing * scale;
  const arm = s.armSwing * scale;
  return new THREE.AnimationClip(name, period, [
    pitchTrack("LegL", 0, t, [leg, 0, -leg, 0, leg]),
    pitchTrack("LegR", 0, t, [-leg, 0, leg, 0, -leg]),
    pitchTrack("ArmL", s.restArm, t, [-arm, 0, arm, 0, -arm]),
    pitchTrack("ArmR", s.restArm, t, [arm, 0, -arm, 0, arm]),
    pitchTrack("Torso", s.restTorso, [0, period], [lean, lean]),
    bobTrack(t, [-dip, 0, -dip, 0, -dip]),
  ]);
}

function idleClip(s: GaitSpec): THREE.AnimationClip {
  const period = 2.6;
  const t = [0, period / 2, period];
  return new THREE.AnimationClip("idle", period, [
    bobTrack(t, [0, -s.breathe, 0]),
    pitchTrack("Torso", s.restTorso, t, [0, 0.02, 0]),
    pitchTrack("ArmL", s.restArm, t, [0, 0.04, 0]),
    pitchTrack("ArmR", s.restArm, t, [0, 0.04, 0]),
  ]);
}

/** The swing: cock the main (right) arm back, throw it forward past horizontal,
 *  settle — the wind-up → strike → recovery shape of the 2D attack. An arm hangs
 *  along −y, so *negative* pitch swings it toward the +z facing. */
function attackClip(s: GaitSpec): THREE.AnimationClip {
  const strike = ATTACK_PERIOD * 0.35; // 2D STRIKE_PEAK: quick wind-up, slower recovery
  return new THREE.AnimationClip("attack", ATTACK_PERIOD, [
    pitchTrack("ArmR", s.restArm, [0, strike * 0.6, strike, ATTACK_PERIOD], [0, 0.9, -1.5, -0.1]),
    pitchTrack("Torso", s.restTorso, [0, strike * 0.6, strike, ATTACK_PERIOD], [0, -0.06, 0.14, 0.02]),
    bobTrack([0, strike, ATTACK_PERIOD], [0, -0.03, 0]),
  ]);
}

/** Wrap a built body in the animation machinery: mixer, the four standard actions,
 *  and the white hit flash over this instance's materials. */
export function finishCreature(root: THREE.Group, parts: Parts, spec: GaitSpec, height: number): CreatureModel {
  const mixer = new THREE.AnimationMixer(root);
  const actions = {
    idle: mixer.clipAction(idleClip(spec)),
    walk: mixer.clipAction(gaitClip("walk", WALK_PERIOD, spec, 1, spec.walkDip, 0)),
    run: mixer.clipAction(gaitClip("run", RUN_PERIOD, spec, 1.55, spec.runDip, spec.runLean)),
    attack: mixer.clipAction(attackClip(spec)),
  };
  actions.attack.setLoop(THREE.LoopOnce, 1);
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
  return { root, mixer, actions, materials: parts.materials, handR, handL, height, flash };
}
