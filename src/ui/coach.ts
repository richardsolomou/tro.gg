import { hudRoot } from "./hud.js";

/**
 * First-time onboarding hints (the "coach"). New players can't discover the
 * verbs by clicking — pickup is `E`, equip is a right-click in the pack — so a
 * milestone the trogg reaches for the first time raises a short hint card,
 * once ever. Progress is per-browser (localStorage): each id fires a single
 * time across all sessions, so a returning player is never re-taught.
 *
 * Call sites announce milestones with `coachHit(id)` (a window event, so no
 * component needs a reference to the coach); the coach shows the matching hint
 * if it hasn't already.
 */
export type MilestoneId = "find-pickaxe" | "first-pickup" | "first-equip" | "first-use" | "mined-stone" | "chopped-wood" | "afk-unlocked";

const HINTS: Record<MilestoneId, string> = {
  "find-pickaxe": "You wake beside a pickaxe. Walk onto it and press E to pick it up.",
  "first-pickup": "In your pack. Press I to open it, then right-click an item to equip it.",
  "first-equip": "Equipped! Hold F to swing it — break boulders and fell trees.",
  "first-use": "Keep at it — face a boulder or tree and hold F until it breaks.",
  "mined-stone": "Stone! Boulders break into it — the stuff you'll build with.",
  "chopped-wood": "Wood! Felled trees give it.",
  "afk-unlocked": "Your trogg can now keep gathering while you're away — log off on safe ground and it works on.",
};

const STORE_KEY = "tro.gg:coach";
const HOLD_MS = 7000;
const EVENT = "trogg-coach";

/** Announce a milestone; the coach shows its hint the first time only. */
export function coachHit(id: MilestoneId): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
}

function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** Mount the coach: listens for milestone events and shows unseen hints, one at
 *  a time (later ones queue behind the current). */
export function mountCoach(): void {
  document.getElementById("coach")?.remove();
  const seen = loadSeen();
  const persist = () => localStorage.setItem(STORE_KEY, JSON.stringify([...seen]));

  const card = document.createElement("div");
  card.id = "coach";
  card.className = "coach";
  card.setAttribute("role", "status");
  card.hidden = true;
  const text = document.createElement("span");
  card.appendChild(text);
  hudRoot().appendChild(card);

  const queue: MilestoneId[] = [];
  let timer = 0;

  const dismiss = () => {
    window.clearTimeout(timer);
    card.classList.add("is-leaving");
    window.setTimeout(() => {
      card.hidden = true;
      card.classList.remove("is-leaving");
      next();
    }, 250);
  };

  const next = () => {
    if (!card.hidden) return;
    const id = queue.shift();
    if (!id) return;
    text.textContent = HINTS[id];
    card.hidden = false;
    timer = window.setTimeout(dismiss, HOLD_MS);
  };

  card.addEventListener("click", dismiss);

  window.addEventListener(EVENT, ((event: Event) => {
    const id = (event as CustomEvent<MilestoneId>).detail;
    if (seen.has(id) || queue.includes(id)) return;
    seen.add(id);
    persist();
    queue.push(id);
    next();
  }) as EventListener);
}
