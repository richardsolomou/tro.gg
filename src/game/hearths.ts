import * as THREE from "three";
import type { Brazier } from "../net/module_bindings/types";
import { ITEM_3D, UI_3D } from "./palette.js";
import { poolGeometry, poolMaterial } from "./pool.js";

const stoneMat = poolMaterial("hearth:stone", () => new THREE.MeshStandardMaterial({ color: ITEM_3D.rock, roughness: 1, flatShading: true }));
const coldCoalMat = poolMaterial("hearth:coal:cold", () => new THREE.MeshStandardMaterial({ color: 0x17120f, roughness: 1 }));
const hotCoalMat = poolMaterial("hearth:coal:hot", () => new THREE.MeshStandardMaterial({ color: 0x24130d, emissive: 0x5a1c08, emissiveIntensity: 0.7, roughness: 1 }));
const flameMat = (colour: number) =>
  poolMaterial(`hearth:flame:${colour}`, () => new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.94, depthWrite: false }));

function stone(parent: THREE.Group, angle: number, scale: number): void {
  const block = new THREE.Mesh(
    poolGeometry("hearth:stone-block", () => new THREE.BoxGeometry(0.48, 0.28, 0.34)),
    stoneMat,
  );
  block.position.set(Math.cos(angle) * 0.48 * scale, 0.14, Math.sin(angle) * 0.48 * scale);
  block.rotation.y = -angle;
  block.scale.setScalar(scale);
  block.castShadow = true;
  parent.add(block);
}

function flame(parent: THREE.Group, colour: number, radius: number, height: number, x: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    poolGeometry(`hearth:flame:${radius}:${height}`, () => new THREE.ConeGeometry(radius, height, 6)),
    flameMat(colour),
  );
  mesh.position.set(x, 0.58 + height / 2, z);
  parent.add(mesh);
  return mesh;
}

export interface BrazierView {
  root: THREE.Group;
  aura: THREE.Group;
  flames: THREE.Mesh[];
  light: THREE.PointLight;
  lightIntensity: number;
  lit: boolean;
  phase: number;
}

export function buildBrazier(row: Brazier): BrazierView {
  const scale = row.isEternal ? 1.45 : 1;
  const root = new THREE.Group();
  for (let i = 0; i < 8; i++) stone(root, (i / 8) * Math.PI * 2, scale);

  const coals = new THREE.Mesh(
    poolGeometry("hearth:coals", () => new THREE.CylinderGeometry(0.38, 0.44, 0.12, 8)),
    row.lit ? hotCoalMat : coldCoalMat,
  );
  coals.position.y = 0.32;
  coals.scale.setScalar(scale);
  root.add(coals);

  const flames = [
    flame(root, 0xff8c2e, 0.24 * scale, 0.9 * scale, 0, 0),
    flame(root, 0xffd37a, 0.14 * scale, 0.65 * scale, -0.09 * scale, 0.02),
    flame(root, 0xd94f1e, 0.11 * scale, 0.48 * scale, 0.16 * scale, 0.03),
  ];

  const aura = new THREE.Group();
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(row.radius, Math.max(32, row.radius * 8)),
    new THREE.MeshBasicMaterial({ color: 0xffb45b, transparent: true, opacity: 0.055, depthWrite: false }),
  );
  fill.rotation.x = -Math.PI / 2;
  fill.position.y = 0.012;
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0, row.radius - 0.08), row.radius + 0.08, Math.max(32, row.radius * 8)),
    new THREE.MeshBasicMaterial({ color: UI_3D.gold, transparent: true, opacity: 0.22, depthWrite: false }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.014;
  aura.add(fill, rim);
  root.add(aura);

  const lightIntensity = row.isEternal ? 16 : 10;
  const light = new THREE.PointLight(0xff8c2e, lightIntensity, row.radius * 2, 1.25);
  light.position.y = 1.2 * scale;
  light.castShadow = false;
  root.add(light);

  const view = { root, aura, flames, light, lightIntensity, lit: row.lit, phase: Number(row.id % 97n) };
  setBrazierLit(view, row.lit);
  return view;
}

export function setBrazierLit(view: BrazierView, lit: boolean): void {
  view.lit = lit;
  view.aura.visible = lit;
  view.light.visible = lit;
  for (const mesh of view.flames) mesh.visible = lit;
}

export function updateBrazier(view: BrazierView, nowMs: number): void {
  if (!view.lit) return;
  const t = nowMs * 0.006 + view.phase;
  view.flames.forEach((mesh, index) => {
    const pulse = 0.88 + Math.sin(t + index * 1.9) * 0.12;
    mesh.scale.set(1 / pulse, pulse, 1 / pulse);
    mesh.rotation.y = t * (index % 2 === 0 ? 0.08 : -0.1);
  });
  view.light.intensity = view.lightIntensity + Math.sin(t * 1.7) * view.lightIntensity * 0.12;
}
