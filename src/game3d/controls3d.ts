import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/**
 * Orbit controls tuned for play:
 *
 * - **Rotate regardless of held modifier keys.** Stock OrbitControls reinterpret
 *   shift/ctrl/meta + left-drag as a pan, which reads as a dead drag with panning
 *   disabled — and shift is the run key, so orbiting mid-run must keep working. A
 *   capture-phase shim masks the modifier flags before the controls see the event.
 * - **No inertia.** The camera tracks the mouse 1:1 and stops the instant the drag
 *   does, so where it lands is always exactly where you left it.
 * - **Pointer lock once a drag starts.** A mouse drag that travels past the click
 *   threshold captures the pointer, so the cursor can't run off the screen edge or
 *   leave the window mid-orbit; release (or Esc) frees it. Plain clicks never
 *   lock. OrbitControls reads absolute cursor positions — frozen under lock — so
 *   locked rotation is driven here from the pointer's movement deltas instead.
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
  controls.enableDamping = false;
  attachDragLock(camera, dom, controls);
  return controls;
}

/** How far (px) a press may travel and still count as a click, not a drag. Shared
 *  with the world's click-to-move detection. */
export const CLICK_SLOP_PX = 6;

function attachDragLock(camera: THREE.Camera, dom: HTMLElement, controls: OrbitControls): void {
  let dragging = false;
  let travelled = 0;
  let locked = false;
  let lockAttempted = false;

  dom.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    dragging = true;
    travelled = 0;
    lockAttempted = false;
  });

  const release = () => {
    dragging = false;
    if (locked) document.exitPointerLock();
  };
  dom.addEventListener("pointerup", release);
  dom.addEventListener("pointercancel", release);

  document.addEventListener("pointerlockchange", () => {
    locked = document.pointerLockElement === dom;
  });

  dom.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    travelled += Math.abs(e.movementX) + Math.abs(e.movementY);
    if (!locked && !lockAttempted && travelled > CLICK_SLOP_PX) {
      // A real drag is underway — capture the cursor for the rest of it (once per
      // drag; still within the pointerdown's transient activation). Environments
      // that refuse pointer lock just keep the plain drag.
      lockAttempted = true;
      try {
        (dom.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {});
      } catch {
        // unavailable — plain drag it is
      }
      return;
    }
    if (!locked) return;
    // Locked: rotate from movement deltas, matching OrbitControls' feel (a full
    // viewport-height drag sweeps ~2π), clamped to the controls' polar limits.
    const perPixel = (2 * Math.PI) / Math.max(1, dom.clientHeight);
    const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= e.movementX * perPixel;
    spherical.phi -= e.movementY * perPixel;
    spherical.phi = Math.max(controls.minPolarAngle + 1e-3, Math.min(controls.maxPolarAngle - 1e-3, spherical.phi));
    spherical.makeSafe();
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    camera.lookAt(controls.target);
  });
}
