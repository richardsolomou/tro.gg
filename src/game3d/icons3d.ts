import * as THREE from "three";
import { buildHog, buildTrogg } from "./creatures3d.js";
import { buildBoulder, buildHeldItem } from "./items3d.js";

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

/** A trogg style's icon canvas (the art preview's creature palette). */
export function troggIcon(style: string): HTMLCanvasElement {
  return cached(`trogg:${style}`, () => buildTrogg(style).root);
}
