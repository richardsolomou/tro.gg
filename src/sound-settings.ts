/**
 * Player sound preferences: a 0–1 level per category, persisted in localStorage
 * and shared by everything that makes noise — the sound-effect cues (audio.ts),
 * the generative theme (theme.ts, on the landing page too), and the Settings
 * panel that edits them (ui/settings.ts). Every cue in the game belongs to
 * exactly one category, so the four sliders cover the whole mix.
 */

export const SOUND_CATEGORIES = [
  { id: "music", label: "Music", blurb: "The game theme" },
  { id: "footsteps", label: "Footsteps", blurb: "Troggs and Hogs on the move" },
  { id: "world", label: "World", blurb: "Boulders, Hog snuffles, the ghost" },
  { id: "interface", label: "Interface", blurb: "Chat, commands, errors" },
] as const;

export type SoundCategory = (typeof SOUND_CATEGORIES)[number]["id"];

const STORE_KEY = "trogg-sound-levels";

type Levels = Partial<Record<SoundCategory, number>>;

function load(): Levels {
  try {
    return (JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") ?? {}) as Levels;
  } catch {
    return {};
  }
}

const levels: Levels = load();
const listeners = new Set<(category: SoundCategory, level: number) => void>();

const clamp = (level: number) => Math.min(1, Math.max(0, level));

/** The saved level for a category, 0–1; full volume unless the player dialled it. */
export function soundLevel(category: SoundCategory): number {
  const saved = levels[category];
  return typeof saved === "number" && Number.isFinite(saved) ? clamp(saved) : 1;
}

export function setSoundLevel(category: SoundCategory, level: number): void {
  levels[category] = clamp(level);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(levels));
  } catch {
    // storage unavailable — the level still applies for this session
  }
  for (const listener of listeners) listener(category, soundLevel(category));
}

/** Watch for level changes — for sounds already playing that must re-mix live. */
export function onSoundLevel(listener: (category: SoundCategory, level: number) => void): void {
  listeners.add(listener);
}
