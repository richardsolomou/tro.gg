import "./hud.css";

let root: HTMLDivElement | undefined;

/**
 * The HUD overlay layer above the Phaser canvas. It is `pointer-events: none` so
 * clicks on empty space fall through to the game (click-to-move); each panel opts
 * back in with `pointer-events: auto`, so a click on a panel is consumed by the DOM
 * and never reaches the canvas. This is what lets the HUD be plain HTML/CSS while
 * the world stays in Phaser.
 */
export function hudRoot(): HTMLDivElement {
  if (!root) {
    root = document.createElement("div");
    root.id = "hud";
    document.body.appendChild(root);
  }
  return root;
}
