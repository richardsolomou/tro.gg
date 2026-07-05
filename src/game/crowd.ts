import * as THREE from "three";
import { TROGG_SKINS_3D } from "./palette.js";

/**
 * The far crowd: creatures beyond the full-rig budget render as tiny instanced
 * silhouettes instead of vanishing. A jointed rig is ~25 draws plus a shadow
 * pass, so only the nearest few earn one — but a hidden crowd reads as an
 * abandoned world from a zoomed-out camera. Every budgeted-out creature
 * becomes one instance of a species-shaped, species-coloured lump that still
 * glides and turns with its live projected motion: the whole distant
 * population costs two draw calls, and the world stays visibly inhabited.
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

export type CrowdKind = "trogg";

export class FarCrowd {
  private readonly meshes: Record<CrowdKind, THREE.InstancedMesh>;
  private readonly counts: Record<CrowdKind, number> = { trogg: 0 };
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly colour = new THREE.Color();

  constructor(scene: THREE.Scene) {
    const make = (geo: THREE.BufferGeometry) => {
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
      const mesh = new THREE.InstancedMesh(geo, mat, CAPACITY);
      mesh.count = 0;
      mesh.frustumCulled = false; // instances span the zone
      scene.add(mesh);
      return mesh;
    };
    this.meshes = { trogg: make(troggSilhouette()) };
  }

  /** Start a frame: forget last frame's crowd. */
  begin(): void {
    this.counts.trogg = 0;
  }

  /** Place one distant creature this frame. */
  add(kind: CrowdKind, x: number, y: number, yaw: number, size: number, style: string, tint?: number): void {
    const slot = this.counts[kind];
    if (slot >= CAPACITY) return;
    this.counts[kind] = slot + 1;
    const mesh = this.meshes[kind];
    this.quat.setFromAxisAngle(this.up, yaw);
    this.matrix.compose(this.pos.set(x + size / 2, 0, y + size / 2), this.quat, this.scale.setScalar(size));
    mesh.setMatrixAt(slot, this.matrix);
    troggColour(style, tint ?? 0xffffff, this.colour);
    mesh.setColorAt(slot, this.colour);
  }

  /** Flush the frame's crowd to the GPU. */
  commit(): void {
    for (const kind of ["trogg"] as const) {
      const mesh = this.meshes[kind];
      mesh.count = this.counts[kind];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}
