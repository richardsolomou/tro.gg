import { ClientMessage, type MovePayload, type ZoneState } from "@tro/shared";
import type { Room } from "colyseus.js";

/** Keys → axis contribution. WASD and arrows both drive the same intent. */
const KEY_VECTORS: Record<string, MovePayload> = {
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
 * Translates held WASD/arrow keys into direction intents and sends one only on
 * transitions (invariant 2: input-driven, never per-frame). Holding moves;
 * releasing every key stops. Returns a teardown that detaches the listeners.
 */
export function attachKeyboard(room: Room<ZoneState>): () => void {
  const held = new Set<string>();
  let sent: MovePayload = { dirX: 0, dirY: 0 };

  const sync = () => {
    let dirX = 0;
    let dirY = 0;
    for (const code of held) {
      const vector = KEY_VECTORS[code];
      if (!vector) continue;
      dirX += vector.dirX;
      dirY += vector.dirY;
    }
    dirX = Math.sign(dirX);
    dirY = Math.sign(dirY);
    if (dirX === sent.dirX && dirY === sent.dirY) return;
    sent = { dirX, dirY };
    room.send(ClientMessage.Move, sent);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.code in KEY_VECTORS) || isTyping(e.target)) return;
    e.preventDefault();
    if (held.has(e.code)) return; // ignore auto-repeat
    held.add(e.code);
    sync();
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (!held.delete(e.code)) return;
    sync();
  };

  // A lost focus (tab switch, alt-tab) strands held keys; release them.
  const onBlur = () => {
    if (held.size === 0) return;
    held.clear();
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
