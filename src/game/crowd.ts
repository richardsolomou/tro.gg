import * as THREE from "three";
import { TROGG_SKINS_3D } from "./palette.js";

/**
 * The far crowd: troggs beyond the full-rig budget render as tiny instanced
 * silhouettes instead of vanishing. A jointed rig is ~25 draws plus a shadow
 * pass, so only the nearest few earn one — but a hidden crowd reads as an
 * abandoned world from a zoomed-out camera. Every budgeted-out trogg becomes
 * one instance of a body-shaped, tint-coloured lump that still glides and
 * turns with its live projected motion: the whole distant population costs
 * one draw call, and the world stays visibly inhabited.
 *
 * Rebuilt from scratch each frame (`begin` → `add`… → `commit`); at far-crowd
 * sizes nobody misses gait or faces, so there are no mixers and no shadows.
 */

const CAPACITY = 256;

const tintScratch = new THREE.Color();

/** A trogg silhouette's colour: the style's skin under the player tint. */
function troggColour(style: string, tint: number, out: THREE.Color): THREE.Color {
  const base = (TROGG_SKINS_3D[style] ?? TROGG_SKINS_3D.moss!).base;
  return out.setHex(base).multiply(tintScratch.setHex(tint));
}

/** The trogg lump: a hunched body block under a smaller head block. */
function troggSilhouette(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.72, 1.0, 0.5).translate(0, 0.62, 0);
  const head = new THREE.BoxGeometry(0.46, 0.4, 0.42).translate(0, 1.3, 0.08);
  return mergeGeometries(body, head);
}

/** Minimal position+normal merge — enough for two flat-shaded boxes; avoids the
 *  full BufferGeometryUtils addon for one call site. */
function mergeGeometries(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const merged = new THREE.BufferGeometry();
  for (const name of ["position", "normal"] as const) {
    const va = (a.index ? a.toNonIndexed() : a).getAttribute(name);
    const vb = (b.index ? b.toNonIndexed() : b).getAttribute(name);
    const out = new Float32Array(va.array.length + vb.array.length);
    out.set(va.array as Float32Array, 0);
    out.set(vb.array as Float32Array, va.array.length);
    merged.setAttribute(name, new THREE.BufferAttribute(out, 3));
  }
  return merged;
}

export class FarCrowd {
  private readonly mesh: THREE.InstancedMesh;
  private count = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly colour = new THREE.Color();

  constructor(scene: THREE.Scene) {
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this.mesh = new THREE.InstancedMesh(troggSilhouette(), mat, CAPACITY);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // instances span the zone
    scene.add(this.mesh);
  }

  /** Start a frame: forget last frame's crowd. */
  begin(): void {
    this.count = 0;
  }

  /** Place one distant trogg this frame. */
  add(x: number, y: number, yaw: number, size: number, style: string, tint?: number): void {
    const slot = this.count;
    if (slot >= CAPACITY) return;
    this.count = slot + 1;
    this.quat.setFromAxisAngle(this.up, yaw);
    this.matrix.compose(this.pos.set(x + size / 2, 0, y + size / 2), this.quat, this.scale.setScalar(size));
    this.mesh.setMatrixAt(slot, this.matrix);
    troggColour(style, tint ?? 0xffffff, this.colour);
    this.mesh.setColorAt(slot, this.colour);
  }

  /** Flush the frame's crowd to the GPU. */
  commit(): void {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
