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

/** Room → client messages, beyond the synced state. */
export const ServerMessage = {
  /** A live chat line to render as a speech bubble over the speaker's head. */
  ChatBubble: "chat_bubble",
} as const;

export type ServerMessageType = (typeof ServerMessage)[keyof typeof ServerMessage];

/** WASD intent: each component is -1, 0, or 1; (0, 0) = stop. */
export interface MovePayload {
  dirX: number;
  dirY: number;
}

/** A chat line from a client; trimmed and length-capped server-side. */
export interface ChatPayload {
  text: string;
}

/** A live bubble: the speaker's session (to anchor it) plus the text. */
export interface ChatBubblePayload {
  sessionId: string;
  text: string;
}
