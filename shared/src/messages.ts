/**
 * Room message types. Movement and chat are synced as input-driven intents
 * (invariant 2), never per-frame. Payloads land with their mechanic — these are
 * the channel names the client and room agree on.
 */
export const ClientMessage = {
  /** Click-to-move: a destination tile the room pathfinds to. (M0/M1) */
  MoveTo: "move_to",
  /** WASD: a direction intent, (0,0) = stop. (M0) */
  Move: "move",
  /** A chat line, zone-scoped. (M0) */
  Chat: "chat",
} as const;

export type ClientMessageType = (typeof ClientMessage)[keyof typeof ClientMessage];

/** WASD intent: each component is -1, 0, or 1; (0, 0) = stop. */
export interface MovePayload {
  dirX: number;
  dirY: number;
}
