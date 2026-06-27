import Phaser from "phaser";
import { WorldScene, type WorldSceneData } from "./scenes/WorldScene.js";

/**
 * Create the Phaser game and boot the world scene with the live connection
 * (GDD "Camera and rendering"). `pixelArt` keeps the art crisp (nearest filtering,
 * rounded pixels); RESIZE fills the parent container, which is the viewport.
 */
export function StartGame(parent: string, data: WorldSceneData): Phaser.Game {
  const game = new Phaser.Game({
    type: Phaser.WEBGL,
    parent,
    backgroundColor: "#0a0806",
    pixelArt: true,
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    // Listen only on the canvas, not the window. The HUD is HTML over the canvas with
    // `pointer-events`, so a click on a panel never reaches the canvas — but Phaser's
    // default window-level mousedown would still fire (the event bubbles to window) and
    // move the trogg under the panel. Canvas-only input lets the DOM shadow it properly.
    input: { windowEvents: false },
  });
  game.scene.add("world", WorldScene, true, data);
  return game;
}
