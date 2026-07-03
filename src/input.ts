import { EQUIPMENT_ACTION_MS } from "@trogg/shared";

/** A movement direction: each axis −1/0/1, diagonals allowed; (0, 0) = stop. */
interface Dir {
  dirX: number;
  dirY: number;
}

/** WASD intent: a direction plus whether shift is held to run — GDD "Movement". */
export interface MoveIntent extends Dir {
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
 * Translates held WASD/arrow keys (plus shift for running) into movement intents and
 * reports each change via `onIntent`. It only reports the *desired* intent — the world
 * layer decides when to send it to the server, holding it until the trogg sits on a
 * tile centre so movement stays grid-locked (GDD "Movement"). Holding shift while
 * moving runs, unless `canRun` is false (the `running` flag is off), in which case
 * shift is ignored and the trogg always walks. `immediate` is set on focus loss, where
 * the step can't finish (a backgrounded tab's ticker is frozen) and the trogg must stop
 * where it is. Reports only on transitions (invariant 2: input-driven, never per-frame).
 * `onInteract` fires on the interact key (`E`) — a discrete press (auto-repeat ignored),
 * the generic action key the world layer uses to pick up / put down (GDD "Interacting").
 * `onUseEquipped` fires on `F` and repeats at the swing cadence while `F` stays
 * held, so chained attacks are a hold, not a tap-per-swing (GDD "Avatars and
 * equipment"). The server's use cooldown stays the authority on rate.
 * Returns a teardown that detaches the listeners.
 */
export function attachKeyboard(
  onIntent: (intent: MoveIntent, immediate?: boolean) => void,
  onInteract: () => void,
  onUseEquipped: () => void,
  canRun: boolean,
): () => void {
  const held = new Set<string>();
  let shiftHeld = false;
  let useRepeat: number | undefined;
  let current: MoveIntent = { dirX: 0, dirY: 0, running: false };

  // Free 8-directional movement: the axes combine, so holding W+D walks the
  // diagonal. Within one axis the newest held key wins (a Set keeps insertion
  // order): holding right then tapping left goes left, releasing left resumes
  // right. Running only matters while moving, so a lone shift tap never moves.
  const compute = (): MoveIntent => {
    let dirX = 0;
    let dirY = 0;
    for (const code of held) {
      const vector = KEY_VECTORS[code];
      if (!vector) continue;
      if (vector.dirX !== 0) dirX = vector.dirX;
      if (vector.dirY !== 0) dirY = vector.dirY;
    }
    const moving = dirX !== 0 || dirY !== 0;
    return { dirX, dirY, running: canRun && shiftHeld && moving };
  };

  const emit = (immediate?: boolean) => {
    const intent = compute();
    if (intent.dirX === current.dirX && intent.dirY === current.dirY && intent.running === current.running) return;
    current = intent;
    onIntent(intent, immediate);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return;
    if (e.code === "KeyE") {
      if (e.repeat) return; // discrete press, not auto-repeat
      e.preventDefault();
      onInteract();
      return;
    }
    if (e.code === "KeyF") {
      if (e.repeat) return;
      e.preventDefault();
      onUseEquipped();
      useRepeat ??= window.setInterval(onUseEquipped, EQUIPMENT_ACTION_MS);
      return;
    }
    if (SHIFT_CODES.has(e.code)) {
      if (shiftHeld) return; // ignore auto-repeat
      shiftHeld = true;
      emit();
      return;
    }
    if (!(e.code in KEY_VECTORS)) return;
    e.preventDefault();
    if (held.has(e.code)) return; // ignore auto-repeat
    held.add(e.code);
    emit();
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "KeyF") {
      window.clearInterval(useRepeat);
      useRepeat = undefined;
      return;
    }
    if (SHIFT_CODES.has(e.code)) {
      if (!shiftHeld) return;
      shiftHeld = false;
      emit();
      return;
    }
    if (!held.delete(e.code)) return;
    emit();
  };

  // A lost focus (tab switch, alt-tab) strands held keys; release them and stop now.
  const onBlur = () => {
    window.clearInterval(useRepeat);
    useRepeat = undefined;
    if (held.size === 0 && !shiftHeld) return;
    held.clear();
    shiftHeld = false;
    emit(true);
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  return () => {
    window.clearInterval(useRepeat);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
  };
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable === true;
}
