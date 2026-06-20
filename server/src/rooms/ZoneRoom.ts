import { ErrorCode, Room, ServerError, type Client } from "colyseus";
import {
  CHAT_HISTORY_MAX,
  CHAT_MAX_CHARS,
  CHAT_RATE_LIMIT_MS,
  ChatMessage,
  type ChatPayload,
  ClientMessage,
  type MovePayload,
  Player,
  projectMotion,
  ServerMessage,
  STARTING_ZONE,
  troggColor,
  ZoneState,
} from "@trogg/shared";
import { verifyGuestToken } from "../auth/guestToken.js";
import { getGameStore, type GameStore, type PlayerRecord } from "../persistence/gameStore.js";

/** What `onAuth` resolves and `onJoin` reads — the server-verified durable id. */
interface GuestAuth {
  userId: string;
}

/** How often dirty players are flushed from the Redis cache to durable Postgres. */
const PERSIST_FLUSH_MS = 15_000;

/**
 * One room per zone (GDD "Multiplayer scaling stance"). Presence, WASD movement,
 * and zone-scoped chat, all persisted: a player hydrates from the store on join
 * (Redis cache → Postgres → new trogg) and writes back on move, leave, and a
 * periodic flush; chat replays its recent history on create. Motion intents
 * settle into authoritative position; Colyseus diffs the state to everyone in
 * the room. No simulation loop (invariant 1): position is derived from the
 * stored intent, never advanced on a timer — the flush below only persists, it
 * never mutates room state.
 */
export class ZoneRoom extends Room<{ state: ZoneState }> {
  private store!: GameStore;
  /** sessionId → durable user id, kept server-side (not synced to clients). */
  private readonly userIds = new Map<string, string>();
  /** Sessions changed since the last durable flush. */
  private readonly dirty = new Set<string>();
  /** sessionId → last chat time (room clock ms), for the per-player rate limit. */
  private readonly lastChatAt = new Map<string, number>();

  /**
   * Verify the guest credential at matchmaking time (GDD "Identity"), before a
   * seat is reserved. The signed token is the only source of identity — never a
   * client-supplied id (invariant 3). Runs as a static method so a rejection
   * fails the matchmake request itself; the returned id becomes `client.auth`.
   */
  static async onAuth(token: string): Promise<GuestAuth> {
    const userId = verifyGuestToken(token);
    if (!userId) throw new ServerError(ErrorCode.AUTH_FAILED, "invalid or missing guest credential");
    return { userId };
  }

  async onCreate() {
    this.state = new ZoneState();
    this.state.slug = STARTING_ZONE.slug;
    this.store = getGameStore();

    this.onMessage(ClientMessage.Move, (client, message: MovePayload) => this.onMove(client, message));
    this.onMessage(ClientMessage.Chat, (client, message: ChatPayload) => this.onChat(client, message));

    if (this.store.persistent) {
      this.clock.setInterval(() => void this.flush(), PERSIST_FLUSH_MS);
    }

    for (const line of await this.store.recentChat(STARTING_ZONE.slug, CHAT_HISTORY_MAX)) {
      this.state.chat.push(pushChat(line.name, line.text, troggColor(line.playerId)));
    }
  }

  /**
   * A WASD direction intent. Settle the player's origin to where they are *now*
   * (so elapsed travel under the old direction isn't lost or replayed), then
   * store the new direction and timestamp. Position between intents is derived,
   * not ticked (invariant 1).
   */
  private onMove(client: Client, message: MovePayload) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const dirX = unitStep(message?.dirX);
    const dirY = unitStep(message?.dirY);

    const now = this.clock.currentTime;
    const settled = projectMotion(player, now - player.movedAt, STARTING_ZONE);
    player.x = settled.x;
    player.y = settled.y;
    player.dirX = dirX;
    player.dirY = dirY;
    player.movedAt = now;

    this.dirty.add(client.sessionId);
    const record = this.recordFor(client.sessionId);
    if (record) void this.store.cache(record);
  }

  /**
   * A zone-scoped chat line. Validate length, enforce a per-player rate limit
   * (invariant 3 — never trust the client), append to the synced history (capped),
   * persist it, and broadcast a live bubble. Content never goes to analytics
   * (invariant 4). The text is rendered as a DOM text node client-side, so no
   * markup escaping is needed here.
   */
  private onChat(client: Client, message: ChatPayload) {
    const player = this.state.players.get(client.sessionId);
    const userId = this.userIds.get(client.sessionId);
    if (!player || !userId) return;

    const text = String(message?.text ?? "").trim().slice(0, CHAT_MAX_CHARS);
    if (!text) return;

    const now = this.clock.currentTime;
    if (now - (this.lastChatAt.get(client.sessionId) ?? -Infinity) < CHAT_RATE_LIMIT_MS) return;
    this.lastChatAt.set(client.sessionId, now);

    this.state.chat.push(pushChat(player.name, text, player.color));
    while (this.state.chat.length > CHAT_HISTORY_MAX) this.state.chat.shift();

    void this.store.appendChat(STARTING_ZONE.slug, userId, text);
    this.broadcast(ServerMessage.ChatBubble, { sessionId: client.sessionId, text });
  }

  async onJoin(client: Client) {
    // Identity comes from the credential onAuth verified, so a returning visitor
    // resumes the same trogg without the client ever asserting who it is.
    const { userId } = client.auth as GuestAuth;
    this.userIds.set(client.sessionId, userId);

    const record = await this.store.load(userId);
    const player = record ? hydrate(record) : freshPlayer(userId);
    player.color = troggColor(userId);
    player.movedAt = this.clock.currentTime;
    this.state.players.set(client.sessionId, player);
  }

  async onLeave(client: Client) {
    const record = this.recordFor(client.sessionId);
    if (record) await this.store.persist(record);

    this.dirty.delete(client.sessionId);
    this.userIds.delete(client.sessionId);
    this.lastChatAt.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
  }

  async onDispose() {
    await this.flush();
  }

  /** Write every dirty player through to durable storage, then clear the set. */
  private async flush() {
    const records = [...this.dirty].map((sessionId) => this.recordFor(sessionId)).filter((r): r is PlayerRecord => r !== null);
    this.dirty.clear();
    await Promise.all(records.map((record) => this.store.persist(record)));
  }

  /** Build a durable record from a live player, settled to its current tile. */
  private recordFor(sessionId: string): PlayerRecord | null {
    const player = this.state.players.get(sessionId);
    const userId = this.userIds.get(sessionId);
    if (!player || !userId) return null;

    const settled = projectMotion(player, this.clock.currentTime - player.movedAt, STARTING_ZONE);
    return {
      userId,
      name: player.name,
      isGuest: player.isGuest,
      zoneId: STARTING_ZONE.slug,
      x: settled.x,
      y: settled.y,
    };
  }
}

/** Restore a player from durable state — resumes idle at the saved tile. */
function hydrate(record: PlayerRecord): Player {
  const player = new Player();
  player.name = record.name;
  player.isGuest = record.isGuest;
  player.x = record.x;
  player.y = record.y;
  return player;
}

/** A brand-new trogg: a stable name from its user id, spawned at zone centre. */
function freshPlayer(userId: string): Player {
  const player = new Player();
  player.name = `trogg-${userId.slice(0, 4)}`;
  player.x = Math.floor(STARTING_ZONE.width / 2);
  player.y = Math.floor(STARTING_ZONE.height / 2);
  return player;
}

/** A ChatMessage schema node for the synced history. */
function pushChat(name: string, text: string, color: number): ChatMessage {
  const message = new ChatMessage();
  message.name = name;
  message.text = text;
  message.color = color;
  return message;
}

/** Coerce an untrusted axis input to -1, 0, or 1. */
function unitStep(value: unknown): number {
  return value === -1 || value === 1 ? value : 0;
}
