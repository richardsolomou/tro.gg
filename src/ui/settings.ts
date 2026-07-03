import { hudIcon } from "../game/icons.js";
import { SOUND_CATEGORIES, setSoundLevel, soundLevel } from "../sound-settings.js";
import { hudLeft } from "./hud.js";
import { registerKeybind } from "./keybinds.js";

/**
 * The Settings panel: a top-left toggle beside Help holding global preferences.
 * Today that is the sound mix — one 0–100% slider per category from
 * SOUND_CATEGORIES, so every cue in the game is under some slider. Levels apply
 * live (the theme re-mixes without restarting) and persist in localStorage,
 * which the landing page theme reads too.
 */
export function mountSettings(): void {
  const root = document.createElement("div");
  root.className = "settings";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "hud-icon-button settings-toggle";
  toggle.appendChild(hudIcon("settings"));
  toggle.setAttribute("aria-label", "Settings");
  toggle.setAttribute("aria-keyshortcuts", "O");
  toggle.title = "Settings (O)";

  const body = document.createElement("div");
  body.className = "help-body settings-body";
  body.hidden = true;

  const title = document.createElement("div");
  title.className = "help-section-title";
  title.textContent = "Sound";
  body.appendChild(title);

  const rows = document.createElement("div");
  rows.className = "settings-rows";
  for (const category of SOUND_CATEGORIES) {
    const label = document.createElement("label");
    label.className = "settings-label";
    label.textContent = category.label;
    label.htmlFor = `sound-${category.id}`;
    label.title = category.blurb;

    const slider = document.createElement("input");
    slider.type = "range";
    slider.id = `sound-${category.id}`;
    slider.min = "0";
    slider.max = "100";
    slider.value = String(Math.round(soundLevel(category.id) * 100));

    const value = document.createElement("span");
    value.className = "settings-value";
    const show = () => {
      value.textContent = `${slider.value}%`;
    };
    show();
    slider.addEventListener("input", () => {
      setSoundLevel(category.id, Number(slider.value) / 100);
      show();
    });

    rows.append(label, slider, value);
  }
  body.appendChild(rows);

  const setOpen = (open: boolean) => {
    const opening = open && body.hidden;
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", String(!body.hidden));
    if (opening) window.dispatchEvent(new CustomEvent("hud-menu-open", { detail: "settings" }));
  };
  const toggleOpen = () => setOpen(body.hidden === true);
  toggle.addEventListener("click", toggleOpen);
  registerKeybind({ id: "hud-settings", matches: (event) => event.code === "KeyO", handler: toggleOpen });
  // Accordion: opening any left-bar menu closes the others, so two drop-downs never overlap.
  window.addEventListener("hud-menu-open", ((event: Event) => {
    if ((event as CustomEvent<string>).detail !== "settings") setOpen(false);
  }) as EventListener);

  root.append(toggle, body);
  hudLeft().appendChild(root);
}
