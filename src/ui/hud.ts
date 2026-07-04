import "./hud.css";

let root: HTMLDivElement | undefined;
let left: HTMLDivElement | undefined;

/**
 * The HUD overlay above the game canvas. `pointer-events: none` lets clicks on
 * empty space fall through to the game (click-to-move); each panel opts back in with
 * `pointer-events: auto`, so a click on a panel is consumed by the DOM.
 */
export function hudRoot(): HTMLDivElement {
  if (!root) {
    root = document.createElement("div");
    root.id = "hud";
    document.body.appendChild(root);
    blockPinchZoom();
    blockNativeContextMenu();
  }
  return root;
}

/** The page is a game surface, not a document: the browser context menu never
 *  opens (right-click belongs to the game — e.g. inventory tile menus). Text
 *  inputs keep theirs, for paste. */
function blockNativeContextMenu(): void {
  window.addEventListener("contextmenu", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
  });
}

/** Keep a macOS trackpad pinch from browser-zooming the page: Chrome reports the
 *  pinch as ctrl+wheel, Safari as gesture events. Camera zoom on the canvas is
 *  untouched (OrbitControls consumes its own wheel events); cmd+/- still works. */
function blockPinchZoom(): void {
  window.addEventListener("wheel", (e) => e.ctrlKey && e.preventDefault(), { passive: false });
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    window.addEventListener(type, (e) => e.preventDefault());
  }
}

/**
 * The top-left bar the toggle menus (Help, Appearance, Inventory, Commands) share: their
 * toggles sit side by side, and each menu's body drops *below* the bar (absolutely
 * placed), so opening one never shoves another toggle. Only one body is open at a
 * time — each menu listens for the `hud-menu-open` window event and closes when
 * another opens. The bar stays click-through (pointer-events fall to the canvas);
 * each child opts back in.
 */
export function hudLeft(): HTMLDivElement {
  if (!left) {
    left = document.createElement("div");
    left.className = "hud-left";
    hudRoot().appendChild(left);
  }
  return left;
}

export function closeHudMenus(): void {
  window.dispatchEvent(new CustomEvent("hud-menu-open", { detail: "close" }));
}
