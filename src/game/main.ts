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
    // Canvas-only input: Phaser also binds mousedown on the window by default, which
    // fires for HUD-panel clicks (they bubble to window) and would move the trogg under
    // the panel even though pointer-events keep the click off the canvas itself.
    input: { windowEvents: false },
  });
  game.scene.add("world", WorldScene, true, data);
  return game;
}
