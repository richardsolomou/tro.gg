import * as THREE from "three";
import { tileKey, type Coord } from "@trogg/shared";
import { UI_3D } from "./palette.js";

/**
 * Court pressure plates (GDD "Courts and play props"): flat stone discs set
 * into the floor that light amber while a trogg or Hog rests on them. One
 * InstancedMesh draws every plate in the zone; the lit state rides
 * per-instance colour (the NodeField hit-flash pattern), swapped only on
 * change. Lit-ness is derived each frame from the same projected tiles
 * collision uses, so every client sees the same plates light with no server
 * state and no sync.
 */

const UNLIT = new THREE.Color(0x4a3826);
const LIT = new THREE.Color(UI_3D.gold);

export class PlateField {
  private readonly mesh?: THREE.InstancedMesh;
  private readonly keys: string[] = [];
  private readonly lit: boolean[] = [];

  constructor(scene: THREE.Scene, plates: readonly Coord[]) {
    if (plates.length === 0) return;
    const disc = new THREE.CylinderGeometry(0.34, 0.4, 0.06, 12);
    // white albedo so the per-instance colour is the plate's whole look
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, flatShading: true });
    this.mesh = new THREE.InstancedMesh(disc, material, plates.length);
    this.mesh.receiveShadow = true;
    // plates scatter across the zone; the geometry-sized bounds would cull them all
    this.mesh.frustumCulled = false;
    const anchor = new THREE.Matrix4();
    plates.forEach((p, slot) => {
      anchor.makeTranslation(p.x + 0.5, 0.03, p.y + 0.5);
      this.mesh!.setMatrixAt(slot, anchor);
      this.mesh!.setColorAt(slot, UNLIT);
      this.keys.push(tileKey(p.x, p.y));
      this.lit.push(false);
    });
    scene.add(this.mesh);
  }

  /** Re-derive each plate's lit state; uploads colours only when one flips. */
  update(occupied: (key: string) => boolean): void {
    if (!this.mesh) return;
    let changed = false;
    for (let slot = 0; slot < this.keys.length; slot++) {
      const lit = occupied(this.keys[slot]!);
      if (lit === this.lit[slot]) continue;
      this.lit[slot] = lit;
      this.mesh.setColorAt(slot, lit ? LIT : UNLIT);
      changed = true;
    }
    if (changed) this.mesh.instanceColor!.needsUpdate = true;
  }
}
