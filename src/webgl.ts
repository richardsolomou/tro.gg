import * as THREE from "three";

/**
 * WebGL availability guards. three.js throws straight from the
 * `WebGLRenderer` constructor when the browser can't hand back a context (no
 * GPU, WebGL blocked), so a top-level renderer construction takes down every
 * statement after it. Callers probe or build through these helpers and fall
 * back instead.
 */

/** True when the browser can give back a WebGL context. A cheap throwaway
 *  probe — call it before boot work that must not be aborted by a failed
 *  renderer construction. */
export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Build a WebGL renderer, or null when no context is available — so the throw
 *  from the constructor can't abort the caller. */
export function createRenderer(params?: THREE.WebGLRendererParameters): THREE.WebGLRenderer | null {
  try {
    return new THREE.WebGLRenderer(params);
  } catch {
    return null;
  }
}
