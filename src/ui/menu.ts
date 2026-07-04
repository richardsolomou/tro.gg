import { captureEvent, logInfo } from "../analytics.js";
import { signOut } from "../auth.js";
import { renderControls } from "./help.js";
import { renderSoundSettings } from "./settings.js";
import { closeHudMenus, hudRoot } from "./hud.js";
import { registerKeybind } from "./keybinds.js";

export interface GameMenuContext {
  signedIn: boolean;
  authAvailable: boolean;
}

/** The open overlays Escape should dismiss before it opens the game menu — the
 *  map and the left-bar drop-downs/drawers. Closing them all is one broadcast
 *  (`closeHudMenus`); this only asks whether any is currently up. */
function anyOverlayOpen(): boolean {
  return (
    document.querySelector(".worldmap:not([hidden])") !== null ||
    document.querySelector(".inventory-body:not([hidden])") !== null ||
    document.querySelector(".appearance-body:not([hidden])") !== null ||
    document.querySelector(".command-drawer.is-open") !== null
  );
}

/**
 * The game menu (GDD HUD note): a pause-style modal opened with Escape. Its
 * root is a short list — Settings, Help, and Log out (signed in only) — and
 * picking Settings or Help drills into that page with a Back control, the way a
 * normal game menu reads. (The guest "Claim account" button lives under
 * Appearance.)
 *
 * It owns Escape for the whole game: inside a sub-page Escape steps back to the
 * list; at the list it closes; with the menu shut it closes whatever else is
 * open (map, a drawer), else opens the menu. Chat keeps its own Escape — a
 * focused input swallows the keybind — so Escape only reaches here when you
 * aren't typing.
 */
export function mountGameMenu({ signedIn, authAvailable }: GameMenuContext): void {
  const backdrop = document.createElement("div");
  backdrop.className = "game-menu-backdrop";
  backdrop.hidden = true;

  const panel = document.createElement("div");
  panel.className = "panel game-menu";
  backdrop.appendChild(panel);
  hudRoot().appendChild(backdrop);

  type View = "root" | "settings" | "help";
  let view: View = "root";

  const renderRoot = () => {
    panel.replaceChildren();
    const title = document.createElement("div");
    title.className = "help-section-title game-menu-title";
    title.textContent = "Menu";
    panel.appendChild(title);

    const nav = document.createElement("div");
    nav.className = "game-menu-nav";
    nav.append(
      navItem("Settings", () => setView("settings")),
      navItem("Help", () => setView("help")),
    );
    if (authAvailable && signedIn) {
      const out = navItem("Log out", logOut);
      out.classList.add("is-danger");
      nav.appendChild(out);
    }
    panel.appendChild(nav);
  };

  const renderPage = (heading: string, content: HTMLElement) => {
    panel.replaceChildren();
    const header = document.createElement("div");
    header.className = "game-menu-header";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "game-menu-back";
    back.setAttribute("aria-label", "Back");
    back.textContent = "‹";
    back.addEventListener("click", () => setView("root"));
    const title = document.createElement("div");
    title.className = "help-section-title game-menu-title";
    title.textContent = heading;
    header.append(back, title);
    panel.append(header, content);
  };

  const setView = (next: View) => {
    view = next;
    if (next === "settings") renderPage("Settings", renderSoundSettings());
    else if (next === "help") renderPage("Help", renderControls());
    else renderRoot();
  };

  const setOpen = (open: boolean) => {
    if (backdrop.hidden === !open) return;
    backdrop.hidden = !open;
    if (open) {
      setView("root");
      window.dispatchEvent(new CustomEvent("hud-menu-open", { detail: "gamemenu" }));
    }
  };
  const isOpen = () => !backdrop.hidden;

  // clicking the dim backdrop closes; clicking the panel itself does not
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) setOpen(false);
  });

  // Escape, single owner: step back within the menu, then close it, then close
  // whatever else is open, else open the menu on a clear screen.
  registerKeybind({
    id: "game-menu",
    matches: (event) => event.code === "Escape",
    handler: () => {
      if (isOpen()) {
        if (view !== "root") setView("root");
        else setOpen(false);
      } else if (anyOverlayOpen()) {
        closeHudMenus();
      } else {
        setOpen(true);
      }
    },
  });
  // opening any other menu (a drawer, the map) closes this one
  window.addEventListener("hud-menu-open", ((event: Event) => {
    if ((event as CustomEvent<string>).detail !== "gamemenu") setOpen(false);
  }) as EventListener);
}

/** A row in the menu's root list. */
function navItem(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "game-menu-nav-item";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

/** Log out and drop straight back to the landing page (GDD "Identity"). */
function logOut(): void {
  captureEvent("account_signed_out");
  logInfo("Account signed out", { surface: "menu" });
  void signOut().finally(() => {
    window.location.href = "/";
  });
}
