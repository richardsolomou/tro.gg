import { PostgresStore } from "./postgres.js";
import { RedisCache } from "./redis.js";
import type { PlayerRecord } from "./playerRecord.js";

export type { PlayerRecord } from "./playerRecord.js";
export type { ChatLine } from "./postgres.js";

/**
 * Durable game state: Redis as a write-through cache in front of a durable
 * Postgres store (GDD "Data model"). Players cache-and-flush; chat is an
 * append-only log that persists straight to Postgres and replays on room
 * create. Either backend is optional — without DATABASE_URL or REDIS_URL the
 * missing layer is skipped, so the game still boots on a bare checkout
 * (invariant 6). With neither, state is purely in-memory.
 *
 *   load    cache → durable → miss; a durable hit warms the cache.
 *   cache   write a player to Redis only — frequent, cheap (called on each move).
 *   persist write a player through to Redis and Postgres — the durable checkpoint
 *           (called on leave, dispose, and the periodic flush).
 *   appendChat / recentChat  durable chat log; the name is resolved for replay.
 */
export class GameStore {
  constructor(
    private readonly redis: RedisCache | null,
    private readonly postgres: PostgresStore | null,
  ) {}

  async init(): Promise<void> {
    await this.postgres?.init();
  }

  async load(userId: string): Promise<PlayerRecord | null> {
    const cached = await this.redis?.load(userId);
    if (cached) return cached;

    const stored = await this.postgres?.load(userId);
    if (stored) await this.redis?.save(stored);
    return stored ?? null;
  }

  async cache(record: PlayerRecord): Promise<void> {
    await this.redis?.save(record);
  }

  async persist(record: PlayerRecord): Promise<void> {
    await Promise.all([this.redis?.save(record), this.postgres?.save(record)]);
  }

  async appendChat(zoneId: string, playerId: string, text: string): Promise<void> {
    await this.postgres?.saveChat(zoneId, playerId, text);
  }

  async recentChat(zoneId: string, limit: number) {
    return (await this.postgres?.recentChat(zoneId, limit)) ?? [];
  }

  async close(): Promise<void> {
    await Promise.all([this.redis?.close(), this.postgres?.close()]);
  }

  get persistent(): boolean {
    return this.redis !== null || this.postgres !== null;
  }
}

let singleton: GameStore | null = null;

/** Process-wide store, built once from the environment and shared by all rooms. */
export function getGameStore(): GameStore {
  if (!singleton) {
    singleton = new GameStore(RedisCache.fromEnv(), PostgresStore.fromEnv());
  }
  return singleton;
}
