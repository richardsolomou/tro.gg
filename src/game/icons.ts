import * as THREE from "three";
import { buildHog, buildTrogg } from "./creatures.js";
import { buildBoulder, buildHeldItem } from "./items.js";
import { ITEM_3D } from "./palette.js";

/**
 * HUD icons rendered from the real 3D models — the inventory, equipped slot, and
 * Commands-panel spawn buttons show the same object the world renders, one model
 * per thing, not separate icon art. Each icon is rendered once on demand into its
 * own small transparent canvas and cached; a shared offscreen renderer paints
 * them all, so the HUD costs one extra WebGL context total.
 */

const ICON_PX = 96;

let shared: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera } | undefined;

function rig() {
  if (shared) return shared;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(ICON_PX, ICON_PX);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff2dc, 0x40301c, 1.6));
  const key = new THREE.DirectionalLight(0xffe8c0, 2.2);
  key.position.set(2, 4, 3);
  scene.add(key);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
  shared = { renderer, scene, camera };
  return shared;
}

/** Render a model into a fresh transparent canvas, framed at the 3/4 icon angle. */
function renderIcon(model: THREE.Object3D): HTMLCanvasElement {
  const { renderer, scene, camera } = rig();
  scene.add(model);
  const bounds = new THREE.Box3().setFromObject(model);
  const centre = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 0.5;
  const distance = radius / Math.tan((camera.fov * Math.PI) / 360) + radius;
  camera.position.copy(centre).add(new THREE.Vector3(0.55, 0.75, 1).normalize().multiplyScalar(distance));
  camera.lookAt(centre);
  renderer.render(scene, camera);
  scene.remove(model);
  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) for (const m of material) m.dispose();
    else material?.dispose();
  });
  const canvas = document.createElement("canvas");
  canvas.width = ICON_PX;
  canvas.height = ICON_PX;
  canvas.getContext("2d")!.drawImage(renderer.domElement, 0, 0);
  return canvas;
}

const cache = new Map<string, HTMLCanvasElement>();

function cached(key: string, build: () => THREE.Object3D | undefined): HTMLCanvasElement {
  let icon = cache.get(key);
  if (!icon) {
    const model = build();
    if (model) {
      icon = renderIcon(model);
    } else {
      icon = document.createElement("canvas");
      icon.width = ICON_PX;
      icon.height = ICON_PX;
    }
    cache.set(key, icon);
  }
  const copy = document.createElement("canvas");
  copy.width = icon.width;
  copy.height = icon.height;
  copy.getContext("2d")!.drawImage(icon, 0, 0);
  copy.className = "item-icon";
  return copy;
}

/** An item's (or the boulder's) icon canvas. Unknown ids render blank. */
export function itemIcon(item: string): HTMLCanvasElement {
  return cached(`item:${item}`, () => {
    if (item === "boulder") return buildBoulder();
    const model = buildHeldItem(item);
    model?.rotation.set(0, 0.5, 0); // upright, slightly turned — the shelf pose
    return model;
  });
}

/** A hog style's icon canvas (the Commands panel spawn buttons). */
export function hogIcon(style: string): HTMLCanvasElement {
  return cached(`hog:${style}`, () => buildHog(style).root);
}

/** A trogg style's icon canvas (the model preview's creature palette). */
export function troggIcon(style: string): HTMLCanvasElement {
  return cached(`trogg:${style}`, () => buildTrogg(style).root);
}

// ── HUD toggle props ─────────────────────────────────────────────────────────────
// The panel toggles get the same treatment as the items: tiny low-poly props
// rendered by the shared rig, so every icon in the HUD is a 3D model.

function propMat(colour: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: colour, roughness: 0.9, flatShading: true });
}

function propBox(parent: THREE.Object3D, w: number, h: number, d: number, colour: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), propMat(colour));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/** The cinched leather sack (inventory). */
function buildSack(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), propMat(ITEM_3D.woodLt));
  body.scale.y = 0.9;
  body.position.y = 0.26;
  g.add(body);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.14, 6), propMat(ITEM_3D.wood));
  neck.position.y = 0.56;
  g.add(neck);
  propBox(g, 0.2, 0.05, 0.08, ITEM_3D.woodDk, 0, 0.56); // the tie
  return g;
}

/** The debug lever on its stone base (commands). */
function buildLever(): THREE.Group {
  const g = new THREE.Group();
  propBox(g, 0.44, 0.16, 0.3, ITEM_3D.rockDk, 0, 0.08);
  const stick = propBox(g, 0.07, 0.5, 0.07, ITEM_3D.wood, 0.08, 0.36);
  stick.rotation.z = -0.5;
  const knob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 0), propMat(ITEM_3D.gold));
  knob.position.set(0.2, 0.6, 0);
  g.add(knob);
  return g;
}

/** The paint pot with a resting brush (appearance). */
function buildPaintPot(): THREE.Group {
  const g = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.3, 7), propMat(ITEM_3D.rock));
  pot.position.y = 0.15;
  g.add(pot);
  const paint = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.05, 7), propMat(0x3fbf7a));
  paint.position.y = 0.31;
  g.add(paint);
  const brush = propBox(g, 0.05, 0.42, 0.05, ITEM_3D.woodLt, 0.14, 0.42);
  brush.rotation.z = -0.45;
  propBox(g, 0.07, 0.1, 0.07, ITEM_3D.steel, 0.24, 0.24).rotation.z = -0.45;
  return g;
}

/** A chunky carved question mark (help). */
function buildQuestion(): THREE.Group {
  const g = new THREE.Group();
  const c = ITEM_3D.rockLt;
  propBox(g, 0.34, 0.1, 0.12, c, 0, 0.78); // top bar
  propBox(g, 0.1, 0.14, 0.12, c, -0.17, 0.68); // left shoulder
  propBox(g, 0.1, 0.22, 0.12, c, 0.17, 0.64); // right descender
  propBox(g, 0.22, 0.1, 0.12, c, 0.06, 0.5); // curl inward
  propBox(g, 0.1, 0.14, 0.12, c, 0, 0.38); // stem
  propBox(g, 0.11, 0.11, 0.12, c, 0, 0.14); // the dot
  return g;
}

/** A hand bell on its wooden mount (settings — the sound mix). */
function buildBell(): THREE.Group {
  const g = new THREE.Group();
  const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.28, 0.32, 7), propMat(ITEM_3D.gold));
  dome.position.y = 0.42;
  g.add(dome);
  const lip = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.08, 7), propMat(ITEM_3D.gold));
  lip.position.y = 0.24;
  g.add(lip);
  propBox(g, 0.09, 0.12, 0.09, ITEM_3D.wood, 0, 0.63); // the handle
  const clapper = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 0), propMat(ITEM_3D.steel));
  clapper.position.y = 0.14;
  g.add(clapper);
  return g;
}

const HUD_PROPS: Record<string, () => THREE.Object3D> = {
  inventory: buildSack,
  commands: buildLever,
  appearance: buildPaintPot,
  help: buildQuestion,
  settings: buildBell,
};

/** A HUD panel-toggle icon canvas: the prop for that panel, same pipeline as items. */
export function hudIcon(kind: "inventory" | "commands" | "appearance" | "help" | "settings"): HTMLCanvasElement {
  return cached(`hud:${kind}`, () => {
    const model = HUD_PROPS[kind]!();
    model.rotation.y = 0.5;
    return model;
  });
}
