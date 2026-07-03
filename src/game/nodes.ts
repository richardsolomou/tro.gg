import * as THREE from "three";

/**
 * Instanced gathering nodes. A zone holds hundreds of identical trees and
 * boulders; drawn as individual meshes they were most of the frame's draw
 * calls (each part × each node × the shadow pass). A NodeField extracts the
 * part meshes from one built template and draws every node of that kind as
 * one InstancedMesh per part — a whole forest costs three draw calls.
 *
 * The white hit pop rides per-instance colour: the material's albedo is
 * white and each instance carries its part's real colour, so flashing a node
 * is setting its instance colour to white for a beat — the same look the
 * old per-mesh colour swap gave.
 */

/** How long the white hit pop holds. */
const FLASH_MS = 130;

interface Part {
  mesh: THREE.InstancedMesh;
  /** The part's transform within the template, tile-anchored like `place`. */
  local: THREE.Matrix4;
  base: THREE.Color;
}

export class NodeField {
  private readonly parts: Part[] = [];
  private readonly slots = new Map<string, number>();
  private readonly ids: string[] = [];
  private readonly flashTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly scratch = new THREE.Matrix4();
  private readonly anchor = new THREE.Matrix4();
  private readonly colour = new THREE.Color();

  constructor(scene: THREE.Scene, template: THREE.Group, capacity: number) {
    // centre the template on its tile, exactly as entities.place anchored the
    // old per-node groups
    const wrap = new THREE.Group();
    template.position.set(0.5, 0, 0.5);
    wrap.add(template);
    wrap.updateMatrixWorld(true);
    wrap.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material as THREE.MeshStandardMaterial;
      const material = src.clone();
      delete material.userData.shared; // this clone is the field's own, not the pool's
      const base = material.color.clone();
      material.color.set(0xffffff);
      const instanced = new THREE.InstancedMesh(mesh.geometry, material, capacity);
      instanced.count = 0;
      instanced.castShadow = mesh.castShadow;
      instanced.receiveShadow = mesh.receiveShadow;
      // instances scatter across the zone; the geometry-sized bounds would cull them all
      instanced.frustumCulled = false;
      scene.add(instanced);
      this.parts.push({ mesh: instanced, local: mesh.matrixWorld.clone(), base });
    });
  }

  /** Add a node (or re-anchor an existing one) at a tile. */
  set(id: string, x: number, y: number): void {
    let slot = this.slots.get(id);
    if (slot === undefined) {
      slot = this.ids.length;
      if (slot >= (this.parts[0]?.mesh.instanceMatrix.count ?? 0)) return; // server caps below capacity
      this.slots.set(id, slot);
      this.ids.push(id);
    }
    this.anchor.makeTranslation(x, 0, y);
    for (const part of this.parts) {
      part.mesh.setMatrixAt(slot, this.scratch.multiplyMatrices(this.anchor, part.local));
      part.mesh.setColorAt(slot, part.base);
      part.mesh.count = this.ids.length;
      part.mesh.instanceMatrix.needsUpdate = true;
      part.mesh.instanceColor!.needsUpdate = true;
    }
  }

  /** Remove a node: the last slot swaps into its place. */
  remove(id: string): void {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    const lastSlot = this.ids.length - 1;
    const lastId = this.ids[lastSlot]!;
    for (const part of this.parts) {
      if (slot !== lastSlot) {
        part.mesh.getMatrixAt(lastSlot, this.scratch);
        part.mesh.setMatrixAt(slot, this.scratch);
        part.mesh.getColorAt(lastSlot, this.colour);
        part.mesh.setColorAt(slot, this.colour);
      }
      part.mesh.count = lastSlot;
      part.mesh.instanceMatrix.needsUpdate = true;
      part.mesh.instanceColor!.needsUpdate = true;
    }
    if (slot !== lastSlot) {
      this.ids[slot] = lastId;
      this.slots.set(lastId, slot);
    }
    this.ids.pop();
    this.slots.delete(id);
    const timer = this.flashTimers.get(id);
    if (timer) clearTimeout(timer);
    this.flashTimers.delete(id);
  }

  /** The white hit pop for a swing landing on this node. */
  flash(id: string): void {
    const paint = (nodeId: string, white: boolean) => {
      const slot = this.slots.get(nodeId);
      if (slot === undefined) return;
      for (const part of this.parts) {
        part.mesh.setColorAt(slot, white ? this.colour.set(0xffffff) : part.base);
        part.mesh.instanceColor!.needsUpdate = true;
      }
    };
    paint(id, true);
    const timer = this.flashTimers.get(id);
    if (timer) clearTimeout(timer);
    this.flashTimers.set(
      id,
      setTimeout(() => {
        this.flashTimers.delete(id);
        paint(id, false);
      }, FLASH_MS),
    );
  }
}
