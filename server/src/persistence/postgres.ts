import { Pool } from "pg";
import type { PlayerRecord } from "./playerRecord.js";

/**
 * Durable store for player state — the source of truth behind the Redis cache
 * (GDD "Data model": Postgres is durable, the room state is a projection of it).
 * Columns mirror the `players` table in the GDD; motion is persisted settled
 * (idle at the resolved tile), so durable state is "where the trogg is", never
 * an in-flight intent tied to a process-relative clock.
 */
export class PostgresStore {
  constructor(private readonly pool: Pool) {}

  static fromEnv(): PostgresStore | null {
    const url = process.env.DATABASE_URL;
    if (!url) return null;
    return new PostgresStore(new Pool({ connectionString: url }));
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        user_id    TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        is_guest   BOOLEAN NOT NULL DEFAULT TRUE,
        zone_id    TEXT NOT NULL,
        x          DOUBLE PRECISION NOT NULL,
        y          DOUBLE PRECISION NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async load(userId: string): Promise<PlayerRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT user_id, name, is_guest, zone_id, x, y FROM players WHERE user_id = $1`,
      [userId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      name: row.name,
      isGuest: row.is_guest,
      zoneId: row.zone_id,
      x: row.x,
      y: row.y,
    };
  }

  async save(record: PlayerRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO players (user_id, name, is_guest, zone_id, x, y, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (user_id) DO UPDATE SET
         name = EXCLUDED.name,
         is_guest = EXCLUDED.is_guest,
         zone_id = EXCLUDED.zone_id,
         x = EXCLUDED.x,
         y = EXCLUDED.y,
         updated_at = now()`,
      [record.userId, record.name, record.isGuest, record.zoneId, record.x, record.y],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
