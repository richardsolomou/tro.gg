import "./hud.css";

let root: HTMLDivElement | undefined;
let left: HTMLDivElement | undefined;

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

/**
 * The top-left stack the toggle panels (Help, Appearance) share. A flex column, so
 * opening one panel's body pushes the next toggle down instead of overlapping it —
 * the column itself stays click-through (pointer-events fall to the canvas), each
 * child opts back in.
 */
export function hudLeft(): HTMLDivElement {
  if (!left) {
    left = document.createElement("div");
    left.className = "hud-left";
    hudRoot().appendChild(left);
  }
  return left;
}
