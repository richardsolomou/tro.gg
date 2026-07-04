import { World3D, type WorldData } from "./world.js";

/**
 * Boot the 3D world into the given parent element with the live connection
 * (GDD "Camera and rendering"). The renderer owns the canvas and the frame loop;
 * HUD chrome stays HTML above it.
 */
export function StartGame(parent: string, data: WorldData): World3D {
  const host = document.getElementById(parent);
  if (!host) throw new Error(`Missing game parent element #${parent}`);
  const world = new World3D(host, data);
  world.start();
  return world;
}
