import * as THREE from "three";
import { MOVE_SPEED_TILES_PER_SEC, RUN_SPEED_TILES_PER_SEC } from "@trogg/shared";
import { createTrogg } from "./trogg_model.js";

/**
 * Full-3D spike (`/spike3d`): one zone, one trogg, the walk/run/attack loop
 * end-to-end in Three.js — a connectionless probe of what tro.gg would feel like
 * as a 3D game. Everything on screen is generated in code (no modelled assets),
 * movement reuses the shared tile-per-second speeds, and the camera sits at the
 * game's 3/4 angle. No netcode; this page decides nothing about the real game.
 */

const ZONE = 24; // ground span in tiles, matching a cosy zone

// ── renderer / scene ─────────────────────────────────────────────────────────────

// `preserveDrawingBuffer` lets the e2e smoke test read pixels back, like the art preview.
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbcd0e8); // pale morning sky
scene.fog = new THREE.Fog(0xbcd0e8, 18, 34);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── light ────────────────────────────────────────────────────────────────────────

scene.add(new THREE.HemisphereLight(0xd8e8c8, 0x3a4a20, 1.1));
const sun = new THREE.DirectionalLight(0xfff2d0, 2.2);
sun.position.set(8, 14, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -16;
sun.shadow.camera.right = 16;
sun.shadow.camera.top = 16;
sun.shadow.camera.bottom = -16;
scene.add(sun);

// ── ground ───────────────────────────────────────────────────────────────────────
// A painted canvas texture in the GSC grass palette — chunky two-tone tiles with
// sparse darker tufts, nearest-filtered so the pixels stay crisp like the 2D game.

function groundTexture(): THREE.CanvasTexture {
  const px = 8; // texels per tile
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ZONE * px;
  const ctx = canvas.getContext("2d")!;
  const light = "#7ba24a";
  const dark = "#6e9440";
  const tuft = "#557a30";
  for (let ty = 0; ty < ZONE; ty++)
    for (let tx = 0; tx < ZONE; tx++) {
      ctx.fillStyle = (tx + ty) % 2 === 0 ? light : dark;
      ctx.fillRect(tx * px, ty * px, px, px);
      // a deterministic little tuft on some tiles
      if ((tx * 7 + ty * 13) % 5 === 0) {
        ctx.fillStyle = tuft;
        const ox = ((tx * 11 + ty * 3) % (px - 2)) + 1;
        const oy = ((tx * 5 + ty * 17) % (px - 2)) + 1;
        ctx.fillRect(tx * px + ox, ty * px + oy, 2, 1);
      }
    }
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const ground = new THREE.Mesh(new THREE.PlaneGeometry(ZONE, ZONE), new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ── scenery: boulders and pines, flat-shaded primitives in the world palette ──────

function addBoulder(x: number, z: number, s: number): void {
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), new THREE.MeshStandardMaterial({ color: 0x74786c, roughness: 1, flatShading: true }));
  rock.position.set(x, s * 0.6, z);
  rock.rotation.set(x, z, x + z); // any fixed orientation; variety without randomness
  rock.castShadow = true;
  rock.receiveShadow = true;
  scene.add(rock);
}

function addPine(x: number, z: number, s: number): void {
  const tree = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12 * s, 0.16 * s, 0.7 * s, 6), new THREE.MeshStandardMaterial({ color: 0x5a3d20, roughness: 1, flatShading: true }));
  trunk.position.y = 0.35 * s;
  const leaves = new THREE.MeshStandardMaterial({ color: 0x38481c, roughness: 1, flatShading: true });
  const tiers: [number, number, number][] = [[0.9, 0.8, 0.8], [0.7, 0.7, 1.35], [0.45, 0.6, 1.85]];
  for (const [r, h, y] of tiers) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r * s, h * s, 7), leaves);
    cone.position.y = y * s;
    cone.castShadow = true;
    tree.add(cone);
  }
  trunk.castShadow = true;
  tree.add(trunk);
  tree.position.set(x, 0, z);
  scene.add(tree);
}

addBoulder(3, -2, 0.55);
addBoulder(-4, 3, 0.7);
addBoulder(6, 5, 0.45);
addBoulder(-7, -6, 0.6);
addPine(-3, -5, 1.1);
addPine(5, -7, 1.35);
addPine(-8, 1, 1.2);
addPine(8, -1, 1);
addPine(-5, 7, 1.25);
addPine(2, 8, 1.15);

// ── the trogg ────────────────────────────────────────────────────────────────────

const trogg = createTrogg();
scene.add(trogg.root);

type Gait = "idle" | "walk" | "run";
let gait: Gait = "idle";
let attackUntil = 0; // clock time the attack swing owns the mixer until
trogg.actions.idle.play();

function setGait(next: Gait): void {
  if (next === gait) return;
  trogg.actions[gait].fadeOut(0.12);
  trogg.actions[next].reset().fadeIn(0.12).play();
  gait = next;
}

function swing(now: number): void {
  if (now < attackUntil) return;
  attackUntil = now + 0.32;
  trogg.actions.attack.reset().fadeIn(0.05).play();
  trogg.actions[gait].fadeOut(0.05);
}

// ── input ────────────────────────────────────────────────────────────────────────

const held = new Set<string>();
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  held.add(e.code);
  if (e.code === "KeyF") swing(clock.elapsedTime);
});
window.addEventListener("keyup", (e) => held.delete(e.code));
window.addEventListener("blur", () => held.clear());

// ── loop ─────────────────────────────────────────────────────────────────────────

const clock = new THREE.Clock();
const CAMERA_OFFSET = new THREE.Vector3(0, 6.5, 7.5); // the 3/4 view, from the south
const lookAt = new THREE.Vector3();

function tick(): void {
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = clock.elapsedTime;

  const dx = (held.has("KeyD") || held.has("ArrowRight") ? 1 : 0) - (held.has("KeyA") || held.has("ArrowLeft") ? 1 : 0);
  const dz = (held.has("KeyS") || held.has("ArrowDown") ? 1 : 0) - (held.has("KeyW") || held.has("ArrowUp") ? 1 : 0);
  const moving = dx !== 0 || dz !== 0;
  const running = moving && (held.has("ShiftLeft") || held.has("ShiftRight"));
  const attacking = now < attackUntil;

  if (moving) {
    const speed = running ? RUN_SPEED_TILES_PER_SEC : MOVE_SPEED_TILES_PER_SEC;
    const len = Math.hypot(dx, dz);
    const half = ZONE / 2 - 0.6;
    trogg.root.position.x = THREE.MathUtils.clamp(trogg.root.position.x + (dx / len) * speed * dt, -half, half);
    trogg.root.position.z = THREE.MathUtils.clamp(trogg.root.position.z + (dz / len) * speed * dt, -half, half);
    // steer toward the movement heading (shortest way round)
    const target = Math.atan2(dx, dz);
    const delta = THREE.MathUtils.euclideanModulo(target - trogg.root.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
    trogg.root.rotation.y += delta * Math.min(1, dt * 14);
  }

  if (attacking) {
    // the swing owns the pose; movement continues underneath
  } else if (trogg.actions.attack.isRunning()) {
    trogg.actions.attack.fadeOut(0.1);
    trogg.actions[gait].reset().fadeIn(0.1).play();
  }
  if (!attacking) setGait(moving ? (running ? "run" : "walk") : "idle");

  trogg.mixer.update(dt);

  // camera follows with a soft lag, always looking at the trogg's chest height
  const eye = trogg.root.position.clone().add(CAMERA_OFFSET);
  camera.position.lerp(eye, Math.min(1, dt * 6));
  lookAt.lerp(trogg.root.position.clone().setY(0.9), Math.min(1, dt * 8));
  camera.lookAt(lookAt);

  renderer.render(scene, camera);
  (window as unknown as { __spike3dReady?: boolean }).__spike3dReady = true;
  requestAnimationFrame(tick);
}

camera.position.copy(CAMERA_OFFSET);
camera.lookAt(0, 0.9, 0);
tick();
