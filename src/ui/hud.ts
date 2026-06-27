import "./hud.css";

let root: HTMLDivElement | undefined;

/**
 * The HUD overlay above the Phaser canvas. `pointer-events: none` lets clicks on
 * empty space fall through to the game (click-to-move); each panel opts back in with
 * `pointer-events: auto`, so a click on a panel is consumed by the DOM.
 */
export function hudRoot(): HTMLDivElement {
  if (!root) {
    root = document.createElement("div");
    root.id = "hud";
    document.body.appendChild(root);
  }
  return root;
}
