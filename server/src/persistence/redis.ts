import { Redis } from "ioredis";
import type { PlayerRecord } from "./playerRecord.js";

const KEY_PREFIX = "player:";

/** Keep warm records around long enough to serve a reconnect without a DB hit. */
const TTL_SECONDS = 60 * 60;

/**
 * Hot cache for player records in front of {@link PostgresStore}. Reads check
 * here first; writes land here on every change (cheap) and are flushed to
 * Postgres less often (durable). Same Redis that backs the Colyseus
 * presence/driver — one store, mirroring prod.
 */
export class RedisCache {
  constructor(private readonly redis: Redis) {}

  static fromEnv(): RedisCache | null {
    const url = process.env.REDIS_URL;
    if (!url) return null;
    return new RedisCache(new Redis(url));
  }

  async load(userId: string): Promise<PlayerRecord | null> {
    const raw = await this.redis.get(KEY_PREFIX + userId);
    return raw ? (JSON.parse(raw) as PlayerRecord) : null;
  }

  async save(record: PlayerRecord): Promise<void> {
    await this.redis.set(KEY_PREFIX + record.userId, JSON.stringify(record), "EX", TTL_SECONDS);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
