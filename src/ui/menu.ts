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
 * The game menu (GDD HUD note): a centred modal — like the world map — holding
 * Help (controls), Settings (the sound mix), and Log out when signed in. (The
 * guest "Claim account" button lives under Appearance, beside name/colour.) It
 * owns Escape for the whole game: with the menu closed and nothing else open,
 * Escape opens it; with something open (map, a drawer, or the menu itself)
 * Escape closes that first. Chat keeps its own Escape — a focused input
 * swallows the keybind — so Escape only reaches here when you aren't typing.
 */
export function mountGameMenu({ signedIn, authAvailable }: GameMenuContext): void {
  const backdrop = document.createElement("div");
  backdrop.className = "game-menu-backdrop";
  backdrop.hidden = true;

  const panel = document.createElement("div");
  panel.className = "panel game-menu";

  const title = document.createElement("div");
  title.className = "help-section-title game-menu-title";
  title.textContent = "Menu";
  panel.appendChild(title);

  panel.appendChild(menuSection("Controls", renderControls()));
  panel.appendChild(menuSection("Sound", renderSoundSettings()));

  // Only signed-in players have anything to do here — Log out. A guest claims an
  // account from the Appearance panel instead.
  if (authAvailable && signedIn) {
    const footer = document.createElement("div");
    footer.className = "game-menu-footer";
    const account = document.createElement("button");
    account.type = "button";
    account.className = "btn";
    account.textContent = "Log out";
    account.addEventListener("click", logOut);
    footer.appendChild(account);
    panel.appendChild(footer);
  }

  backdrop.appendChild(panel);
  hudRoot().appendChild(backdrop);

  const setOpen = (open: boolean) => {
    if (backdrop.hidden === !open) return;
    backdrop.hidden = !open;
    if (open) window.dispatchEvent(new CustomEvent("hud-menu-open", { detail: "gamemenu" }));
  };
  const isOpen = () => !backdrop.hidden;

  // clicking the dim backdrop closes; clicking the panel itself does not
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) setOpen(false);
  });

  // Escape, single owner: close the menu, else close whatever else is open,
  // else open the menu on a clear screen.
  registerKeybind({
    id: "game-menu",
    matches: (event) => event.code === "Escape",
    handler: () => {
      if (isOpen()) setOpen(false);
      else if (anyOverlayOpen()) closeHudMenus();
      else setOpen(true);
    },
  });
  // opening any other menu (a drawer, the map) closes this one
  window.addEventListener("hud-menu-open", ((event: Event) => {
    if ((event as CustomEvent<string>).detail !== "gamemenu") setOpen(false);
  }) as EventListener);
}

/** A titled block in the menu. */
function menuSection(heading: string, content: HTMLElement): HTMLElement {
  const section = document.createElement("div");
  section.className = "game-menu-section";
  const label = document.createElement("div");
  label.className = "help-section-title";
  label.textContent = heading;
  section.append(label, content);
  return section;
}

/** Log out and drop straight back to the landing page (GDD "Identity"). */
function logOut(): void {
  captureEvent("account_signed_out");
  logInfo("Account signed out", { surface: "menu" });
  void signOut().finally(() => {
    window.location.href = "/";
  });
}
