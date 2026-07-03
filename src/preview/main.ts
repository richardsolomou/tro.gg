import * as THREE from "three";
import { createOrbit } from "../game/controls.js";
import { COMMON_HOG_STYLES, HOG_STYLES, hogSize, TROGG_STYLES, wieldOf, type Kind } from "@trogg/shared";
import { buildHog, buildHogBall, buildTrogg } from "../game/creatures.js";
import { buildHeldItem, hasItem3D } from "../game/items.js";
import { hogIcon, itemIcon, troggIcon } from "../game/icons.js";
import { applyFlinch, disposeObject, FLINCH_MS } from "../game/entities.js";
import { type CreatureModel } from "../game/rig.js";

/**
 * Dev model preview (`/preview`): a connectionless Three.js page for inspecting
 * every creature model, animation clip, and held item. Every control is
 * URL-addressable so a preview state is a
 * shareable deep link, e.g.
 * `/preview?view=holder&creature=hog:buff&item=sword&off=shield&mode=attack&paused=1&scrub=0.35&bones=1&yaw=-1.2`.
 * Unknown values fall back to defaults. The e2e harness boots these states
 * headless and asserts the canvas still renders (`e2e/preview.spec.ts`).
 */

interface CreatureChoice {
  kind: Kind;
  style: string;
}

const CREATURES: CreatureChoice[] = [
  ...TROGG_STYLES.map((style) => ({ kind: "trogg" as Kind, style })),
  ...HOG_STYLES.map((style) => ({ kind: "hog" as Kind, style })),
];
const ITEM_CHOICES = ["none", "pickaxe", "shovel", "sword", "shield", "stone"] as const;
const MODES = ["idle", "walk", "run", "attack", "hit", "ball"] as const;
type Mode = (typeof MODES)[number];
/** How often the hit flinch replays in `hit` mode. */
const HIT_LOOP_MS = 900;

// ── state, seeded from the URL (unknown values fall back to defaults) ─────────────

const params = new URLSearchParams(location.search);
const state = {
  view: params.get("view") === "item" ? "item" : "holder",
  creature: parseCreature(params.get("creature")),
  item: parseItem(params.get("item"), "pickaxe"),
  off: parseItem(params.get("off"), "none"),
  mode: parseMode(params.get("mode")),
  paused: params.get("paused") === "1",
  scrub: Math.max(0, Math.min(1, Number(params.get("scrub")) || 0)),
  bones: params.get("bones") === "1",
  // model yaw in radians (URL-only): 0.4 reads as a three-quarter view; ±1.2 near-profile
  yaw: Number.isFinite(Number(params.get("yaw"))) && params.get("yaw") !== null ? Number(params.get("yaw")) : 0.4,
};

function parseCreature(raw: string | null): CreatureChoice {
  if (!raw) return CREATURES[0]!;
  const byIndex = CREATURES[Number(raw)];
  if (byIndex && /^\d+$/.test(raw)) return byIndex;
  const [kind, style] = raw.split(":");
  return CREATURES.find((c) => c.kind === kind && c.style === style) ?? CREATURES[0]!;
}

function parseItem(raw: string | null, fallback: string): string {
  if (raw === "none") return "none";
  return raw && hasItem3D(raw) ? raw : fallback;
}

function parseMode(raw: string | null): Mode {
  return (MODES as readonly string[]).includes(raw ?? "") ? (raw as Mode) : "idle";
}

function syncUrl(): void {
  const q = new URLSearchParams({
    view: state.view,
    creature: `${state.creature.kind}:${state.creature.style}`,
    item: state.item,
    off: state.off,
    mode: state.mode,
  });
  if (state.paused) {
    q.set("paused", "1");
    q.set("scrub", state.scrub.toFixed(2));
  }
  if (state.bones) q.set("bones", "1");
  history.replaceState(null, "", `?${q}`);
}

// ── scene ────────────────────────────────────────────────────────────────────────

const host = document.getElementById("preview")!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0806);
scene.add(new THREE.HemisphereLight(0xffe0b0, 0x201409, 0.9));
const key = new THREE.DirectionalLight(0xffd9a0, 1.8);
key.position.set(3, 5, 4);
key.castShadow = true;
scene.add(key);
// a dim fill from behind so the model still reads when orbited to its dark side
const fill = new THREE.DirectionalLight(0xc0d0ff, 0.5);
fill.position.set(-3, 2, -4);
scene.add(fill);

const floor = new THREE.Mesh(new THREE.CircleGeometry(2.4, 40), new THREE.MeshStandardMaterial({ color: 0x342819, roughness: 1 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
const CAMERA_DIR = new THREE.Vector3(0.28, 0.42, 1).normalize();

// Mouse orbit: drag to rotate around the subject, wheel to zoom.
const orbit = createOrbit(camera, renderer.domElement);
orbit.maxPolarAngle = Math.PI * 0.72; // don't dive under the floor

/** Aim the orbit at the current subject. The first call frames it (camera pulled
 *  back along the default direction until the model fits with headroom); after
 *  that the user's rotation and zoom are theirs — swapping creatures, weapons, or
 *  modes only re-centres the pivot, so a chosen viewing angle survives control
 *  changes. */
let framed = false;
function frame(): void {
  if (!subject) return;
  const bounds = new THREE.Box3().setFromObject(subject);
  const centre = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 0.6;
  const distance = (radius / Math.tan((camera.fov * Math.PI) / 360)) * 1.25;
  if (!framed) {
    camera.position.copy(centre).addScaledVector(CAMERA_DIR, distance);
    camera.lookAt(centre);
    framed = true;
  } else {
    // carry the existing view over to the new pivot: same angle, same distance
    camera.position.add(new THREE.Vector3().subVectors(centre, orbit.target));
  }
  orbit.target.copy(centre);
  orbit.minDistance = radius * 0.5;
  orbit.maxDistance = distance * 5;
  orbit.update();
}

function layout(): void {
  const w = host.clientWidth || window.innerWidth;
  const h = host.clientHeight || window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", layout);
layout();

// ── the subject: one creature (or lone item), rebuilt on any control change ──────

let subject: THREE.Object3D | undefined;
let model: CreatureModel | undefined;
const flinchView = { facing: "down" as const, flashOn: false, flinchBaseMs: undefined as number | undefined, model: undefined as unknown as CreatureModel };
let boneDots: THREE.Group | undefined;
let hitCycleAt = 0;

function currentClip(): { action: THREE.AnimationAction; duration: number } | undefined {
  if (!model) return undefined;
  // attack mode shows the wield class of the selected main-hand item
  const action =
    state.mode === "attack"
      ? model.actions.attacks[wieldOf(state.item)]
      : model.actions[state.mode === "walk" ? "walk" : state.mode === "run" ? "run" : "idle"];
  return { action, duration: action.getClip().duration };
}

function rebuild(): void {
  if (subject) disposeObject(subject);
  if (boneDots) disposeObject(boneDots);
  subject = undefined;
  model = undefined;
  boneDots = undefined;

  if (state.view === "item") {
    const lone = buildHeldItem(state.item === "none" ? "pickaxe" : state.item)!;
    lone.rotation.set(0, 0, 0); // upright shelf pose, spun by the ticker
    lone.position.y = 0.55;
    subject = lone;
    scene.add(lone);
    frame();
    return;
  }

  if (state.mode === "ball") {
    const style = (COMMON_HOG_STYLES as readonly string[]).includes(state.creature.style) ? state.creature.style : "classic";
    const ball = buildHogBall(style);
    ball.position.y = 0.42;
    subject = ball;
    scene.add(ball);
    frame();
    return;
  }

  model = state.creature.kind === "trogg" ? buildTrogg(state.creature.style) : buildHog(state.creature.style);
  const scale = state.creature.kind === "hog" ? hogSize(state.creature.style) : 1;
  model.root.scale.setScalar(scale);
  model.root.rotation.y = state.yaw;
  subject = model.root;
  scene.add(model.root);
  flinchView.model = model;
  flinchView.flashOn = false;
  flinchView.flinchBaseMs = undefined;

  // held items ride the rig's hand nodes, exactly like the game
  for (const [id, hand] of [[state.item, model.handR], [state.off, model.handL]] as const) {
    if (id === "none") continue;
    const m = buildHeldItem(id);
    if (!m) continue;
    m.scale.setScalar(model.fit);
    hand.add(m);
  }

  const clip = currentClip();
  if (clip) {
    if (state.mode === "attack") clip.action.setLoop(THREE.LoopRepeat, Infinity);
    clip.action.reset().play();
  }

  // gold joint dots — the bones overlay, for checking joint placement
  boneDots = new THREE.Group();
  boneDots.visible = state.bones;
  const dotGeo = new THREE.SphereGeometry(0.035, 8, 8);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xf2c94c, depthTest: false });
  model.root.traverse((node) => {
    if (["Bob", "LegL", "LegR", "Torso", "ArmL", "ArmR", "Head", "HandL", "HandR"].includes(node.name)) {
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.renderOrder = 20;
      dot.userData.track = node;
      boneDots!.add(dot);
    }
  });
  scene.add(boneDots);
  frame();
}

// ── controls ─────────────────────────────────────────────────────────────────────

const controls = document.getElementById("controls")!;
const repaints: (() => void)[] = [];

function group(label: string, ...children: HTMLElement[]): HTMLElement {
  const g = document.createElement("div");
  g.className = "group";
  const l = document.createElement("span");
  l.className = "lbl";
  l.textContent = label;
  g.append(l, ...children);
  return g;
}

function button(label: string, isOn: () => boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  repaints.push(() => b.classList.toggle("on", isOn()));
  b.addEventListener("click", () => {
    onClick();
    syncUrl();
    refresh();
  });
  return b;
}

function slot(icon: HTMLElement | string, isOn: () => boolean, onClick: () => void, creature = false): HTMLElement {
  const s = document.createElement("div");
  s.className = creature ? "slot cslot" : "slot";
  if (typeof icon === "string") {
    s.classList.add("slot-none");
    s.textContent = icon;
  } else {
    s.appendChild(icon);
  }
  repaints.push(() => s.classList.toggle("selected", isOn()));
  s.addEventListener("click", () => {
    onClick();
    syncUrl();
    refresh();
  });
  return s;
}

function refresh(): void {
  rebuild();
  for (const p of repaints) p();
}

function mountControls(): void {
  const creatures = document.createElement("div");
  creatures.className = "palette";
  for (const c of CREATURES) {
    const pick = () => {
      state.creature = c;
    };
    creatures.appendChild(slot(c.kind === "trogg" ? troggIcon(c.style) : hogIcon(c.style), () => state.creature.kind === c.kind && state.creature.style === c.style, pick, true));
  }

  const items = document.createElement("div");
  items.className = "palette";
  const offs = document.createElement("div");
  offs.className = "palette";
  for (const id of ITEM_CHOICES) {
    items.appendChild(slot(id === "none" ? "×" : itemIcon(id), () => state.item === id, () => (state.item = id)));
    offs.appendChild(slot(id === "none" ? "×" : itemIcon(id), () => state.off === id, () => (state.off = id)));
  }

  const modes = MODES.map((m) => button(m, () => state.mode === m, () => (state.mode = m)));
  const viewBtn = button("item view", () => state.view === "item", () => (state.view = state.view === "item" ? "holder" : "item"));
  const pauseBtn = button("pause", () => state.paused, () => (state.paused = !state.paused));
  const bonesBtn = button("bones", () => state.bones, () => (state.bones = !state.bones));

  const scrubInput = document.createElement("input");
  scrubInput.type = "range";
  scrubInput.min = "0";
  scrubInput.max = "1";
  scrubInput.step = "0.01";
  scrubInput.value = String(state.scrub);
  scrubInput.addEventListener("input", () => {
    state.scrub = Number(scrubInput.value);
    state.paused = true;
    syncUrl();
    for (const p of repaints) p();
  });

  controls.append(group("creature", creatures), group("main", items), group("off", offs), group("anim", ...modes), group("", viewBtn, pauseBtn, bonesBtn), group("scrub", scrubInput));
  for (const p of repaints) p();
}

// ── loop ─────────────────────────────────────────────────────────────────────────

const clock = new THREE.Clock();

function tick(): void {
  const dt = Math.min(0.1, clock.getDelta());
  const now = performance.now();

  if (state.view === "item" && subject) {
    if (!state.paused) subject.rotation.y += dt * 0.9;
  } else if (model) {
    if (state.mode === "hit") {
      // the in-game flinch, replayed on a loop (or held at `scrub` while paused)
      model.actions.idle.play();
      if (state.paused) {
        flinchView.flinchBaseMs = now - state.scrub * (FLINCH_MS - 1);
      } else if (now >= hitCycleAt) {
        flinchView.flinchBaseMs = now;
        hitCycleAt = now + HIT_LOOP_MS;
      }
      applyFlinch(flinchView, now, 0);
      model.mixer.update(state.paused ? 0 : dt);
    } else if (state.mode !== "ball") {
      const clip = currentClip();
      if (clip && state.paused) {
        clip.action.paused = false;
        clip.action.time = state.scrub * clip.duration;
        model.mixer.update(0);
      } else {
        model.mixer.update(dt);
      }
    }
    if (boneDots?.visible) {
      for (const dot of boneDots.children) {
        (dot.userData.track as THREE.Object3D).getWorldPosition(dot.position);
      }
    }
  }

  orbit.update();
  renderer.render(scene, camera);
  (window as unknown as { __previewReady?: boolean }).__previewReady = true;
  requestAnimationFrame(tick);
}

mountControls();
rebuild();
tick();
