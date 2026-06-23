import type { DbConnection } from "./module_bindings";

/** A cardinal direction: one axis at a time; (0, 0) = stop. No diagonals. */
interface Dir {
  dirX: number;
  dirY: number;
}

/** WASD intent: a direction plus whether shift is held to run — GDD "Movement". */
interface MoveIntent extends Dir {
  running: boolean;
}

/** Shift keys, tracked alongside WASD so holding shift while moving runs. */
const SHIFT_CODES = new Set(["ShiftLeft", "ShiftRight"]);

/** Keys → cardinal direction. WASD and arrows both drive the same intent. */
const KEY_VECTORS: Record<string, Dir> = {
  KeyW: { dirX: 0, dirY: -1 },
  ArrowUp: { dirX: 0, dirY: -1 },
  KeyS: { dirX: 0, dirY: 1 },
  ArrowDown: { dirX: 0, dirY: 1 },
  KeyA: { dirX: -1, dirY: 0 },
  ArrowLeft: { dirX: -1, dirY: 0 },
  KeyD: { dirX: 1, dirY: 0 },
  ArrowRight: { dirX: 1, dirY: 0 },
};

/**
 * Translates held WASD/arrow keys into direction intents and calls the `move`
 * reducer only on transitions (invariant 2: input-driven, never per-frame).
 * Holding moves; releasing every key stops; holding shift while moving runs
 * (GDD "Movement"), unless `canRun` is false (the `running` flag is off), in which
 * case shift is ignored and the trogg always walks. Returns a teardown that
 * detaches the listeners.
 */
export function attachKeyboard(conn: DbConnection, canRun: boolean): () => void {
  const held = new Set<string>();
  let shiftHeld = false;
  let sent: MoveIntent = { dirX: 0, dirY: 0, running: false };

  const sync = () => {
    // Last key still held wins — pure 4-directional movement, no diagonals, like
    // Pokémon/Zelda. A Set keeps insertion order, so the newest held key is the
    // last one we see; holding right then tapping up goes up, releasing up
    // resumes right. Each KEY_VECTORS entry is a single cardinal axis, so the
    // intent is always cardinal by construction.
    let dir = { dirX: 0, dirY: 0 };
    for (const code of held) {
      const vector = KEY_VECTORS[code];
      if (vector) dir = vector;
    }
    const moving = dir.dirX !== 0 || dir.dirY !== 0;
    // Running only matters while moving, so a lone shift tap never fires a move.
    const intent: MoveIntent = { ...dir, running: canRun && shiftHeld && moving };
    if (intent.dirX === sent.dirX && intent.dirY === sent.dirY && intent.running === sent.running) return;
    sent = intent;
    conn.reducers.move(sent);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return;
    if (SHIFT_CODES.has(e.code)) {
      if (shiftHeld) return; // ignore auto-repeat
      shiftHeld = true;
      sync();
      return;
    }
    if (!(e.code in KEY_VECTORS)) return;
    e.preventDefault();
    if (held.has(e.code)) return; // ignore auto-repeat
    held.add(e.code);
    sync();
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (SHIFT_CODES.has(e.code)) {
      if (!shiftHeld) return;
      shiftHeld = false;
      sync();
      return;
    }
    if (!held.delete(e.code)) return;
    sync();
  };

  // A lost focus (tab switch, alt-tab) strands held keys; release them.
  const onBlur = () => {
    if (held.size === 0 && !shiftHeld) return;
    held.clear();
    shiftHeld = false;
    sync();
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
  };
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable === true;
}
