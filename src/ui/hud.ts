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
 * The top-left bar the toggle panels (Help, Appearance) share: their toggles sit
 * side by side, and each panel's body drops *below* the bar (absolutely placed), so
 * opening one never shoves the other toggle. The bar stays click-through
 * (pointer-events fall to the canvas); each child opts back in.
 */
export function hudLeft(): HTMLDivElement {
  if (!left) {
    left = document.createElement("div");
    left.className = "hud-left";
    hudRoot().appendChild(left);
  }
  return left;
}

/**
 * Close every open panel body in the left bar except `keep`. The toggles act as an
 * accordion — only one body open at a time — so two drop-downs can't overlap below
 * the bar. Both panels' bodies carry the `.help-body` class, so one selector covers
 * them.
 */
export function collapseLeftPanels(keep?: HTMLElement): void {
  if (!left) return;
  for (const body of left.querySelectorAll<HTMLElement>(".help-body")) {
    if (body !== keep) body.hidden = true;
  }
}
