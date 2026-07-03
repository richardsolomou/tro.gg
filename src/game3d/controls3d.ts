import type * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/**
 * Orbit controls that rotate regardless of held modifier keys. Stock
 * OrbitControls reinterpret shift/ctrl/meta + left-drag as a pan, which reads
 * as a dead drag with panning disabled — and shift is the run key, so orbiting
 * mid-run must keep working. A capture-phase shim masks the modifier flags
 * before the controls see the pointer event.
 */
export function createOrbit(camera: THREE.Camera, dom: HTMLElement): OrbitControls {
  dom.addEventListener(
    "pointerdown",
    (e) => {
      for (const key of ["shiftKey", "ctrlKey", "metaKey"] as const) {
        Object.defineProperty(e, key, { get: () => false });
      }
    },
    true,
  );
  const controls = new OrbitControls(camera, dom);
  controls.enablePan = false;
  // No inertia: the camera tracks the mouse 1:1 and stops the instant the drag
  // does, so where it lands is always exactly where you left it.
  controls.enableDamping = false;
  return controls;
}
