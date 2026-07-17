import * as THREE from "three";
import { buildGrask, buildTrogg } from "./game/creatures.js";
import type { CreatureModel } from "./game/rig.js";
import { CAVE_3D, GRASK_3D } from "./game/palette.js";

/**
 * The landing page's ambient backdrop: darkness, a rocky low-poly floor, two
 * flickering torches framing the copy, and two troggs sitting in their light.
 * Generic by design (not the game world), so the same look ports to the
 * stream scenes (starting soon / brb / ending) via bin/export-backdrop. No
 * netcode.
 */

const FLAME_HOT = 0xffe08a;
const FLAME_MID = 0xff8c2e;
const FLAME_DEEP = 0xd94f1e;

function rockMat(colour: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: colour, roughness: 1, flatShading: true });
}

/** Deterministic PRNG so the cave looks identical on every visit. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A gently crumpled low-poly ground plane — cave floor without a tilemap. */
function buildGround(rand: () => number): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(60, 40, 48, 32);
  const pos = geo.attributes.position!;
  for (let i = 0; i < pos.count; i++) {
    pos.setZ(i, rand() * 0.35 - 0.1); // pre-rotation z is world up
  }
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, rockMat(CAVE_3D.floor.base));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  return ground;
}

/** The pixel-torch made solid: stick, wrapped head, cel-animated flame, warm light. */
interface Torch {
  group: THREE.Group;
  light: THREE.PointLight;
  /** Three sculpted flame poses, hard-swapped like animation cels (`steps(1)`). */
  frames: THREE.Group[];
  seed: number;
}

/** A small ember blob — the base ember and the stray sparks above the flame. */
function flameBit(parent: THREE.Group, colour: number, r: number, x: number, y: number): void {
  const bit = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.94 }));
  bit.position.set(x, y, 0);
  parent.add(bit);
}

/** The flame's body: a lathed profile — wide low bulge sweeping concavely up to a
 *  sharp point — at a chunky 6 radial segments. The classic stylised fire shape. */
function flameBody(colour: number, r: number, h: number): THREE.Mesh {
  const profile = [
    [0.001, 0],
    [0.72, 0.05],
    [1.0, 0.2],
    [0.8, 0.44],
    [0.45, 0.68],
    [0.16, 0.86],
    [0.001, 1],
  ].map(([px, py]) => new THREE.Vector2(px! * r, py! * h));
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 6), new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.94 }));
  return body;
}

/** A small pointed tongue of fire, leaning outward. */
function flameTongue(parent: THREE.Group, colour: number, r: number, h: number, x: number, y: number, lean: number): void {
  const tongue = new THREE.Mesh(new THREE.ConeGeometry(r, h, 4), new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.94 }));
  tongue.position.set(x, y, 0);
  tongue.rotation.z = lean;
  parent.add(tongue);
}

const FLAME_CELS = 10;

/** One flame cel, sculpted from a seeded RNG: the pointed body holds its shape
 *  (with height jitter and a wandering lean) while tongues and sparks land
 *  somewhere new every frame — endless variation, steady silhouette. */
function flameFrame(rand: () => number): THREE.Group {
  const f = new THREE.Group();
  const h = 0.72 + rand() * 0.18;
  const lean = (rand() - 0.5) * 0.3;

  const body = flameBody(FLAME_MID, 0.24, h);
  body.position.y = 1.56;
  body.rotation.z = lean;
  f.add(body);
  const core = flameBody(FLAME_HOT, 0.15, h * 0.62);
  core.position.y = 1.57;
  core.rotation.z = lean * 0.7;
  f.add(core);

  // a deep-orange base ember on one side or the other
  flameBit(f, FLAME_DEEP, 0.07 + rand() * 0.02, (rand() < 0.5 ? -1 : 1) * (0.1 + rand() * 0.05), 1.6 + rand() * 0.04);

  // one or two pointed tongues licking off the sides
  const tongues = 1 + Math.floor(rand() * 2);
  for (let i = 0; i < tongues; i++) {
    const side = rand() < 0.5 ? -1 : 1;
    flameTongue(f, FLAME_MID, 0.045 + rand() * 0.025, 0.2 + rand() * 0.16, side * (0.12 + rand() * 0.08), 1.86 + rand() * 0.26, -side * (0.25 + rand() * 0.3));
  }
  // sometimes a spark breaks clear above the flame
  if (rand() < 0.45) {
    const side = rand() < 0.5 ? -1 : 1;
    flameBit(f, rand() < 0.5 ? FLAME_DEEP : FLAME_HOT, 0.035 + rand() * 0.02, side * (0.1 + rand() * 0.14) + lean * 0.4, 2.3 + rand() * 0.18);
  }
  return f;
}

function buildTorch(x: number, z: number, seed: number, shadows: boolean): Torch {
  const group = new THREE.Group();
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 1.45, 6), rockMat(0x4a3826));
  stick.position.y = 0.72;
  stick.castShadow = true;
  group.add(stick);
  // the wrapped head — the tarred bundle the flame burns off
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.11, 0.3, 6), rockMat(0x2a2118));
  head.position.y = 1.5;
  group.add(head);

  const celRand = rng(0xf1a3 + seed * 97);
  const frames = Array.from({ length: FLAME_CELS }, () => flameFrame(celRand));
  for (const frame of frames) {
    frame.visible = false;
    group.add(frame);
  }
  frames[0]!.visible = true;

  const light = new THREE.PointLight(FLAME_MID, 9, 14, 1.6);
  light.position.y = 2.0;
  // A shadow-casting point light renders the scene into a 6-face cube map —
  // per torch, per frame. Only the offline still generator pays that.
  if (shadows) {
    light.castShadow = true;
    light.shadow.mapSize.set(512, 512);
  }
  group.add(light);

  group.position.set(x, 0, z);
  return { group, light, frames, seed };
}

/** Pose a creature seated on the floor: legs swung forward, body sunk so the
 *  rump rests on the ground. Idle breathing only drives torso/arms/bob, so the
 *  leg pose holds while the mixer runs. */
function seat(model: CreatureModel, x: number, z: number, yaw: number, sink: number): CreatureModel {
  for (const name of ["LegL", "LegR"]) {
    const leg = model.root.getObjectByName(name);
    if (leg) leg.rotation.x = -Math.PI / 2;
  }
  model.root.position.set(x, -sink, z);
  model.root.rotation.y = yaw;
  model.actions.idle.legs.play();
  model.actions.idle.arms.play();
  return model;
}

/** Pose a grask prowling the rim of the torchlight (GDD "Dark creatures"):
 *  far enough back that the fog nearly swallows the body, leaving a hunched
 *  silhouette and its eye-glow — which skips the fog so it stays baleful. */
function lurk(model: CreatureModel, x: number, z: number, yaw: number): CreatureModel {
  model.root.position.set(x, 0, z);
  model.root.rotation.y = yaw;
  model.root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mat = obj.material as THREE.MeshLambertMaterial;
    if (mat.emissive && mat.emissive.getHex() !== 0) mat.fog = false;
  });
  // A cold violet gleam clinging to the body — the dark's answer to the
  // torch pools, just enough to pick the silhouette out of the black.
  const gleam = new THREE.PointLight(GRASK_3D.eye, 2.2, 4.5, 1.8);
  gleam.position.set(0, 1.1, 0.6);
  model.root.add(gleam);
  model.actions.idle.legs.play();
  model.actions.idle.arms.play();
  return model;
}

export interface BackdropOptions {
  /** Scales the torch light — the ending scene runs dimmer, like a fire burning down. */
  glow?: number;
  /** Pushes the torches and creatures outward from centre. Wide banner crops widen
   *  the horizontal view, so 1 would leave them behind the centred copy. */
  spacing?: number;
  /** "pair" flanks centred copy with both torch groups; "right" keeps only the
   *  right-hand torch and trogg, for left-aligned layouts. */
  layout?: "pair" | "right";
}

interface BackdropScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Advance flames, light flicker, idle breathing, and camera drift to time `t`. */
  tick(t: number, dt: number): void;
}

function buildBackdropScene(glow: number, spacing: number, layout: "pair" | "right", shadows: boolean): BackdropScene {
  const rand = rng(0x7060);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(CAVE_3D.voidBase);
  scene.fog = new THREE.Fog(CAVE_3D.voidBase, 9, 26);
  scene.add(new THREE.HemisphereLight(0xffe0b0, 0x201409, 0.32));
  scene.add(buildGround(rand));

  // Two torches framing the copy, like the old page — now casting real light —
  // with two troggs sitting in their pools, facing the middle.
  const torches = [buildTorch(4.6 * spacing, 1.0, 2, shadows)];
  const creatures = [seat(buildTrogg("ridge"), 3.7 * spacing, 1.8, -0.6, 0.44)];
  if (layout === "pair") {
    torches.push(buildTorch(-4.6 * spacing, 1.0, 1, shadows));
    creatures.push(seat(buildTrogg("moss"), -3.9 * spacing, 1.2, 0.6, 0.44));
  }
  // Grasks prowl the rim where the light gives out — deep enough that the fog
  // reduces them to hunched silhouettes and a violet eye-glow, facing the fire.
  creatures.push(lurk(buildGrask(), 5.0 * spacing, -4.8, -0.6));
  if (layout === "pair") {
    creatures.push(lurk(buildGrask(), -5.2 * spacing, -5.4, 0.6));
    creatures.push(lurk(buildGrask(), -0.9, -8.0, 0.1));
  }

  for (const torch of torches) scene.add(torch.group);
  for (const creature of creatures) scene.add(creature.root);

  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 60);

  const tick = (t: number, dt: number) => {
    for (const creature of creatures) creature.mixer.update(dt);

    // Cel flicker, like the CSS torch's steps(1) frames: swap sculpted flame poses
    // at ~6 fps and step the light with them — never a smooth tween.
    for (const torch of torches) {
      const cel = Math.floor(t * 6 + torch.seed * 2.3) % FLAME_CELS;
      torch.frames.forEach((frame, i) => (frame.visible = i === cel));
      // the pool of light breathes gently, stepped like the old page's glow pools
      const step = Math.floor(t * 7 + torch.seed * 3.7) % 5;
      torch.light.intensity = 10 * glow * [1, 0.86, 1.08, 0.92, 1.02][step]!;
    }

    // A slow breath of camera drift — alive, but not a tour.
    camera.position.set(Math.sin(t * 0.07) * 0.35, 2.6, 9.5);
    camera.lookAt(0, 1.15, 0);
  };
  return { scene, camera, tick };
}

/** The ambient loop's ceiling: the flames step at 6fps and the camera drift is
 *  a slow breath, so a backdrop rendering faster than this only makes heat. */
const BACKDROP_FPS = 30;

export function mountBackdrop(canvas: HTMLCanvasElement, { glow = 1, spacing = 1, layout = "pair" }: BackdropOptions = {}): { stop(): void } {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // a fogged, near-black backdrop — nobody can see past 1.5x density
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

  const { scene, camera, tick } = buildBackdropScene(glow, spacing, layout, false);

  const resize = () => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", resize);
  resize();

  const clock = new THREE.Clock();
  let last = 0;
  let lastFrame = -Infinity;
  renderer.setAnimationLoop(() => {
    const t = clock.getElapsedTime();
    if (t - lastFrame < 1 / BACKDROP_FPS - 0.0015) return;
    lastFrame = t;
    tick(t, t - last);
    last = t;
    renderer.render(scene, camera);
  });
  // Hand the caller the off switch: the page stops burning GPU the moment the
  // player heads into the world, instead of racing the game's load.
  return {
    stop() {
      renderer.setAnimationLoop(null);
    },
  };
}

/** One frame of the backdrop at a fixed size, for the static image generators:
 *  returns a canvas ready for `drawImage` compositing. The buffer is preserved,
 *  so the caller may composite it again later (e.g. after fonts load). */
export function renderBackdropStill(width: number, height: number, { glow = 1, spacing, layout = "pair" }: BackdropOptions = {}): HTMLCanvasElement {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(width, height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // by default, spread the scene so the torches clear a centred text block
  const { scene, camera, tick } = buildBackdropScene(glow, spacing ?? Math.max(1, width / height / 1.9), layout, true);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  tick(0.6, 0.6); // a settled mid-breath pose with both flames lit
  renderer.render(scene, camera);
  return renderer.domElement;
}
