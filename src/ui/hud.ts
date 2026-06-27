import "./hud.css";

let root: HTMLDivElement | undefined;
let toolbar: HTMLDivElement | undefined;

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

/** Shared top-left HUD stack for compact menu toggles. */
export function hudToolbar(): HTMLDivElement {
  const hud = hudRoot();
  if (!toolbar || !toolbar.isConnected) {
    toolbar = document.createElement("div");
    toolbar.id = "hud-toolbar";
    toolbar.className = "hud-toolbar";
    hud.appendChild(toolbar);
  }
  return toolbar;
}

export function closeHudMenus(): void {
  window.dispatchEvent(new CustomEvent("hud-menu-open", { detail: "close" }));
}
