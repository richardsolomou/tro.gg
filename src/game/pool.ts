import * as THREE from "three";

/**
 * Shared GPU resource pools. The models are all built from a small vocabulary
 * of parametric shapes and flat colours, but every build used to allocate its
 * own geometry and material — a hundred troggs meant thousands of identical GPU
 * buffers. Pooled resources are keyed by their parameters, marked
 * `userData.shared`, and never disposed: `disposeObject` (and the icon
 * renderer) skip them, so tearing one model down can't yank a buffer out from
 * under every other instance.
 *
 * Only immutable resources may pool. Anything a model mutates per instance —
 * creature materials (player tint, hit flash, downed fade), overlay canvas
 * textures — must stay per-instance.
 */

const geometries = new Map<string, THREE.BufferGeometry>();

export function poolGeometry(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let geo = geometries.get(key);
  if (!geo) {
    geo = make();
    geo.userData.shared = true;
    geometries.set(key, geo);
  }
  return geo;
}

const materials = new Map<string, THREE.Material>();

export function poolMaterial<T extends THREE.Material>(key: string, make: () => T): T {
  let mat = materials.get(key);
  if (!mat) {
    mat = make();
    mat.userData.shared = true;
    materials.set(key, mat);
  }
  return mat as T;
}
