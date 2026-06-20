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
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id         BIGSERIAL PRIMARY KEY,
        zone_id    TEXT NOT NULL,
        player_id  TEXT NOT NULL,
        text       TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS chat_by_zone_recent ON chat_messages (zone_id, created_at DESC)`,
    );
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

  async saveChat(zoneId: string, playerId: string, text: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO chat_messages (zone_id, player_id, text) VALUES ($1, $2, $3)`,
      [zoneId, playerId, text],
    );
  }

  /** The newest `limit` lines for a zone, returned oldest-first for replay. */
  async recentChat(zoneId: string, limit: number): Promise<ChatLine[]> {
    const { rows } = await this.pool.query(
      `SELECT c.player_id, c.text, p.name
         FROM chat_messages c
         JOIN players p ON p.user_id = c.player_id
        WHERE c.zone_id = $1
        ORDER BY c.created_at DESC
        LIMIT $2`,
      [zoneId, limit],
    );
    return rows.reverse().map((row) => ({ playerId: row.player_id, name: row.name, text: row.text }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** A chat line as rendered: the speaker's id (for their colour), name, and text. */
export interface ChatLine {
  playerId: string;
  name: string;
  text: string;
}
