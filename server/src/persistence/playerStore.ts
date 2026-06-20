import { PostgresStore } from "./postgres.js";
import { RedisCache } from "./redis.js";
import type { PlayerRecord } from "./playerRecord.js";

export type { PlayerRecord } from "./playerRecord.js";

/**
 * Player persistence: Redis as a write-through cache in front of a durable
 * Postgres store (GDD "Data model"). Either backend is optional — without
 * DATABASE_URL or REDIS_URL the missing layer is skipped, so the game still
 * boots on a bare checkout (invariant 6). With neither, state is purely
 * in-memory, as it was before persistence landed.
 *
 *   load    cache → durable → miss; a durable hit warms the cache.
 *   cache   write to Redis only — frequent, cheap (called on each move).
 *   persist write through to Redis and Postgres — the durable checkpoint
 *           (called on leave, dispose, and the periodic flush).
 */
export class PlayerStore {
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

  async close(): Promise<void> {
    await Promise.all([this.redis?.close(), this.postgres?.close()]);
  }

  get persistent(): boolean {
    return this.redis !== null || this.postgres !== null;
  }
}

let singleton: PlayerStore | null = null;

/** Process-wide store, built once from the environment and shared by all rooms. */
export function getPlayerStore(): PlayerStore {
  if (!singleton) {
    singleton = new PlayerStore(RedisCache.fromEnv(), PostgresStore.fromEnv());
  }
  return singleton;
}
