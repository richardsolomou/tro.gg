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
 * - **All rotation is driven here from movement deltas** (stock rotate is off;
 *   OrbitControls keeps wheel zoom). Absolute cursor positions freeze under
 *   pointer lock, and the sky look-up below needs angle state a camera position
 *   cannot express — deltas handle both, locked or not.
 * - **Pointer lock once a drag starts.** A mouse drag that travels past the click
 *   threshold captures the pointer, so the cursor can't run off the screen edge or
 *   leave the window mid-orbit; release (or Esc) frees it. Plain clicks never
 *   lock; environments that refuse the lock keep the plain drag.
 * - **Dragging past the floor looks up at the sky.** An orbit camera can only ever
 *   look at its target, so on its own it bottoms out at the target's height. Once
 *   the ideal orbit position would sink underground, the camera parks skimming the
 *   floor and the extra angle pitches the view upward instead — drag far enough
 *   and you face the sun.
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
  controls.enableRotate = false; // rotation lives in attachDragLock
  attachDragLock(camera, dom, controls);
  return controls;
}

/** How far (px) a press may travel and still count as a click, not a drag. Shared
 *  with the world's click-to-move detection. */
export const CLICK_SLOP_PX = 6;

/** The camera never sinks below this height — the world's floor sits at y=0. */
const FLOOR_Y = 0.5;
/** Polar ceiling for drags: short of straight-down-under, so the sky look-up
 *  tops out near vertical without the azimuth flipping. */
const SKY_MAX_POLAR = Math.PI - 0.2;

function attachDragLock(camera: THREE.Camera, dom: HTMLElement, controls: OrbitControls): void {
  let dragging = false;
  let travelled = 0;
  let locked = false;
  let lockAttempted = false;
  /** Persistent polar angle for drags. The rendered camera position cannot
   *  express angles past the floor (it parks at FLOOR_Y), so deriving the angle
   *  from the position every event would forget the overshoot — this remembers it. */
  let skyPhi: number | null = null;

  /** Re-assert the sky pose: park the camera at the floor and pitch the refused
   *  angle upward. Idempotent, and needed after every stock `update()` — that
   *  call ends with `lookAt(target)`, which would level the view again. */
  const applySkyPose = () => {
    const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    const phiFloor = Math.acos(THREE.MathUtils.clamp((FLOOR_Y - controls.target.y) / spherical.radius, -1, 1));
    if (skyPhi === null || skyPhi <= phiFloor + 1e-3) return; // a plain orbit — stock pose stands
    spherical.phi = phiFloor;
    spherical.makeSafe();
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    camera.lookAt(controls.target);
    camera.rotateX(skyPhi - spherical.phi);
  };
  const stockUpdate = controls.update.bind(controls);
  controls.update = (deltaTime?: number | null) => {
    const changed = stockUpdate(deltaTime);
    applySkyPose();
    return changed;
  };

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
    if (travelled <= CLICK_SLOP_PX) return; // still a click, not a drag
    if (!locked && !lockAttempted) {
      // A real drag is underway — capture the cursor for the rest of it (once per
      // drag; still within the pointerdown's transient activation). Environments
      // that refuse pointer lock just keep the plain drag.
      lockAttempted = true;
      try {
        (dom.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {});
      } catch {
        // unavailable — plain drag it is
      }
    }
    // Rotate from movement deltas, matching OrbitControls' feel (a full
    // viewport-height drag sweeps ~2π).
    const perPixel = (2 * Math.PI) / Math.max(1, dom.clientHeight);
    const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    const phiFloor = Math.acos(THREE.MathUtils.clamp((FLOOR_Y - controls.target.y) / spherical.radius, -1, 1));
    // While the position can express the angle, it is the truth (external moves —
    // the opening snap, zoom — re-sync us); past the floor, the memory takes over.
    if (skyPhi === null || skyPhi <= phiFloor + 1e-3) skyPhi = spherical.phi;
    spherical.theta -= e.movementX * perPixel;
    skyPhi = Math.max(controls.minPolarAngle + 1e-3, Math.min(SKY_MAX_POLAR, skyPhi - e.movementY * perPixel));
    spherical.phi = Math.min(skyPhi, phiFloor);
    spherical.makeSafe();
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    camera.lookAt(controls.target);
    applySkyPose();
  });
}
