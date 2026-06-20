import { ArraySchema, MapSchema, Schema, type } from "@colyseus/schema";

/**
 * Live room-state projection synced to clients (see GDD "Data model"). One room
 * per zone; this is the in-memory state Colyseus diffs to everyone in it. The
 * durable Postgres tables are the source of truth — a room hydrates from them
 * (via a Redis cache) on join and writes durable changes back. Only the settled
 * position is persisted; the motion intent below is transient.
 *
 * Motion is intent-based (invariants 1 & 2): position over time is derived from
 * an origin (x, y) + movedAt and either a direction (WASD) or a path
 * (click-to-move). Clients extrapolate locally between diffs. `path` and
 * `equipment` from the data model are added with their mechanics (M1/M2).
 */
export class Player extends Schema {
  @type("string") name = "";
  @type("boolean") isGuest = true;

  /** Stable marker tint, a projection of the durable id (GDD "Avatars"). */
  @type("uint32") color = 0;

  /** Origin of the current move, in integer tile coords — never the destination. */
  @type("number") x = 0;
  @type("number") y = 0;

  /** WASD direction; (0, 0) = idle. */
  @type("number") dirX = 0;
  @type("number") dirY = 0;

  /** Server clock ms at which the current motion began. */
  @type("number") movedAt = 0;
}

/**
 * One zone-scoped chat line, kept in the room's recent history (GDD "Chat").
 * The generated `name` is denormalised so late joiners render history without a
 * lookup. Content never leaves the game for analytics (invariant 4).
 */
export class ChatMessage extends Schema {
  @type("string") name = "";
  @type("string") text = "";
  /** The speaker's marker colour, denormalised so names render tinted on replay. */
  @type("uint32") color = 0;
}

export class ZoneState extends Schema {
  @type("string") slug = "";
  @type({ map: Player }) players = new MapSchema<Player>();
  /** Recent messages, oldest first; capped at CHAT_HISTORY_MAX. */
  @type([ChatMessage]) chat = new ArraySchema<ChatMessage>();
}
