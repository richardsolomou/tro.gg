import { SOUND_CATEGORIES, setSoundLevel, soundLevel } from "../sound-settings.js";

/**
 * The sound mix, rendered as one 0–100% slider per category for the game
 * menu's Settings tab. Every cue in the game is under some slider; levels apply
 * live (the theme re-mixes without restarting) and persist in localStorage,
 * which the landing page theme reads too.
 */
export function renderSoundSettings(): HTMLElement {
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
  return rows;
}
