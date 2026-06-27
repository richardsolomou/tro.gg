import { PostHog } from "posthog-node";

const serviceName = "trogg-sidecar";
const serviceVersion = process.env.GITHUB_SHA ?? process.env.SERVICE_VERSION ?? "dev";
const environment = process.env.NODE_ENV ?? "development";

const posthogKey = process.env.POSTHOG_PROJECT_TOKEN ?? process.env.POSTHOG_KEY ?? process.env.VITE_POSTHOG_KEY ?? "";
const posthogHost = trimTrailingSlash(process.env.POSTHOG_HOST ?? process.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com");
const spacetimeHost = httpHost(process.env.SPACETIMEDB_HTTP_HOST ?? process.env.SPACETIMEDB_HOST ?? process.env.VITE_SPACETIMEDB_HOST ?? "ws://localhost:3001");
const databaseName = process.env.SPACETIMEDB_DB_NAME ?? process.env.VITE_SPACETIMEDB_DB_NAME ?? "trogg";
const spacetimeToken = process.env.SPACETIMEDB_TOKEN;
const pollMs = Number(process.env.POSTHOG_SIDECAR_POLL_MS ?? 5_000);

const posthog = new PostHog(posthogKey, {
  host: posthogHost,
  personalApiKey: process.env.POSTHOG_PERSONAL_API_KEY,
  disabled: !posthogKey,
});

type LogLevel = "info" | "warn" | "error";
type SqlValue = string | number | boolean | null | unknown[] | Record<string, unknown>;
type SqlRow = Record<string, SqlValue>;

type PlayerRow = {
  identity: string;
  name: string;
  is_guest: boolean;
  zone_id: string;
  online: boolean;
  color: number;
  carrying: string;
  style: number;
  equipped_main_hand: string;
  equipment_action: string;
  equipment_action_at: string;
  equipped_main_hand_inventory_id: string;
};

type InventoryRow = {
  id: string;
  player_id: string;
  item: string;
  qty: number;
};

type ChatRow = {
  id: string;
  zone_id: string;
  sender: string;
};

type Snapshot = {
  players: Map<string, PlayerRow>;
  inventory: Map<string, InventoryRow>;
  chats: Map<string, ChatRow>;
};

type SqlStatement = {
  schema?: unknown;
  rows?: unknown[];
};

async function main() {
  if (!Number.isFinite(pollMs) || pollMs < 1_000) throw new Error("POSTHOG_SIDECAR_POLL_MS must be at least 1000");
  await logInfo("PostHog sidecar starting", { database: databaseName, spacetime_host: spacetimeHost, poll_ms: pollMs, posthog_enabled: Boolean(posthogKey) });

  let previous = await readSnapshot();
  await logInfo("PostHog sidecar baseline loaded", {
    players: previous.players.size,
    inventory_rows: previous.inventory.size,
    chat_rows: previous.chats.size,
  });

  for (;;) {
    await sleep(pollMs);
    try {
      const next = await readSnapshot();
      emitDiff(previous, next);
      previous = next;
    } catch (error) {
      posthog.captureException(error, serviceName, { service: serviceName, database: databaseName });
      await logError("PostHog sidecar poll failed", { database: databaseName, error: normalizeAttribute(error) });
    }
  }
}

async function readSnapshot(): Promise<Snapshot> {
  const [players, inventory, chats] = await querySql(
    [
      "SELECT identity, name, is_guest, zone_id, online, color, carrying, style, equipped_main_hand, equipment_action, equipment_action_at, equipped_main_hand_inventory_id FROM player",
      "SELECT id, player_id, item, qty FROM inventory",
      "SELECT id, zone_id, sender FROM chat_message",
    ].join(";"),
  );

  return {
    players: mapRows<PlayerRow>(players ?? [], (row) => stringField(row, "identity")),
    inventory: mapRows<InventoryRow>(inventory ?? [], (row) => stringField(row, "id")),
    chats: mapRows<ChatRow>(chats ?? [], (row) => stringField(row, "id")),
  };
}

function emitDiff(previous: Snapshot, next: Snapshot): void {
  for (const [id, row] of next.inventory) {
    const old = previous.inventory.get(id);
    const gained = row.qty - (old?.qty ?? 0);
    if (gained > 0) {
      capture(row.player_id, "inventory_item_acquired", {
        zone: next.players.get(row.player_id)?.zone_id,
        item: row.item,
        qty: gained,
        source: "spacetimedb-sidecar",
      });
    }
  }

  for (const [id, player] of next.players) {
    const old = previous.players.get(id);
    if (!old) continue;

    if (old.name !== player.name) capture(id, "trogg_renamed", { zone: player.zone_id, source: "spacetimedb-sidecar" });
    if (old.color !== player.color) capture(id, "trogg_recolored", { color: player.color, source: "spacetimedb-sidecar" });
    if (old.style !== player.style) capture(id, "trogg_restyled", { style: player.style, source: "spacetimedb-sidecar" });

    const equipmentChanged = old.equipped_main_hand !== player.equipped_main_hand || old.equipped_main_hand_inventory_id !== player.equipped_main_hand_inventory_id;
    if (equipmentChanged) {
      capture(id, "item_equipped", {
        zone: player.zone_id,
        item: player.equipped_main_hand || old.equipped_main_hand,
        equipped: player.equipped_main_hand !== "",
        source: "spacetimedb-sidecar",
      });
    }

    if (player.equipment_action && old.equipment_action_at !== player.equipment_action_at) {
      capture(id, "equipped_item_used", { zone: player.zone_id, item: player.equipment_action, source: "spacetimedb-sidecar" });
    }

    if (old.carrying !== player.carrying) {
      capture(id, player.carrying ? "object_picked_up" : "object_dropped", {
        zone: player.zone_id,
        kind: player.carrying || old.carrying,
        source: "spacetimedb-sidecar",
      });
    }
  }

  for (const [id, row] of next.chats) {
    if (!previous.chats.has(id)) capture(row.sender, "chat_sent", { zone: row.zone_id, source: "spacetimedb-sidecar" });
  }
}

function capture(distinctId: string, event: string, properties: Record<string, unknown>) {
  if (!posthogKey) return;
  posthog.capture({ distinctId, event, properties });
}

async function querySql(sql: string): Promise<SqlRow[][]> {
  const response = await fetch(`${spacetimeHost}/v1/database/${encodeURIComponent(databaseName)}/sql`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      ...(spacetimeToken ? { Authorization: `Bearer ${spacetimeToken}` } : {}),
    },
    body: sql,
  });
  if (!response.ok) throw new Error(`SpacetimeDB SQL failed with ${response.status}: ${await response.text()}`);

  const statements = (await response.json()) as SqlStatement[];
  return statements.map((statement) => rowsFromStatement(statement));
}

function rowsFromStatement(statement: SqlStatement): SqlRow[] {
  const fields = fieldsFromSchema(statement.schema);
  return (statement.rows ?? []).map((row) => rowToObject(row, fields));
}

function rowToObject(row: unknown, fields: string[]): SqlRow {
  if (row && typeof row === "object" && !Array.isArray(row)) return normalizeRow(row as Record<string, unknown>);
  if (!Array.isArray(row)) return {};
  return Object.fromEntries(row.map((value, index) => [fields[index] ?? String(index), normalizeValue(value)]));
}

function normalizeRow(row: Record<string, unknown>): SqlRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]));
}

function normalizeValue(value: unknown): SqlValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value === "object") return normalizeRow(value as Record<string, unknown>);
  return String(value);
}

function fieldsFromSchema(schema: unknown): string[] {
  const product = schema && typeof schema === "object" && "Product" in schema ? (schema as { Product?: unknown }).Product : schema;
  const elements = product && typeof product === "object" && "elements" in product ? (product as { elements?: unknown[] }).elements : [];
  return (elements ?? []).map((element, index) => fieldName(element, index));
}

function fieldName(element: unknown, index: number): string {
  if (!element || typeof element !== "object" || !("name" in element)) return String(index);
  const name = (element as { name?: unknown }).name;
  if (typeof name === "string") return name;
  if (name && typeof name === "object" && "some" in name && typeof (name as { some?: unknown }).some === "string") return (name as { some: string }).some;
  return String(index);
}

function mapRows<T>(rows: SqlRow[], key: (row: T) => string): Map<string, T> {
  const mapped = new Map<string, T>();
  for (const row of rows) {
    const typed = coerceRow(row) as T;
    mapped.set(key(typed), typed);
  }
  return mapped;
}

function coerceRow(row: SqlRow): Record<string, unknown> {
  return {
    ...row,
    identity: stringField(row, "identity"),
    id: stringField(row, "id"),
    player_id: stringField(row, "player_id"),
    sender: stringField(row, "sender"),
    is_guest: booleanField(row, "is_guest"),
    online: booleanField(row, "online"),
    color: numberField(row, "color"),
    style: numberField(row, "style"),
    qty: numberField(row, "qty"),
    equipment_action_at: stringField(row, "equipment_action_at"),
    equipped_main_hand_inventory_id: stringField(row, "equipped_main_hand_inventory_id"),
  };
}

function stringField(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function numberField(row: SqlRow, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function booleanField(row: SqlRow, key: string): boolean {
  const value = row[key];
  return typeof value === "boolean" ? value : value === "true";
}

async function logInfo(body: string, attributes?: Record<string, unknown>) {
  console.info(body, attributes ?? "");
  await sendLog("info", body, attributes);
}

async function logError(body: string, attributes?: Record<string, unknown>) {
  console.error(body, attributes ?? "");
  await sendLog("error", body, attributes);
}

async function sendLog(level: LogLevel, body: string, attributes?: Record<string, unknown>) {
  if (!posthogKey) return;
  const now = `${BigInt(Date.now()) * 1_000_000n}`;
  const severity = severityFor(level);
  const payload = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attr("service.name", serviceName),
            attr("service.version", serviceVersion),
            attr("deployment.environment", environment),
          ],
        },
        scopeLogs: [
          {
            scope: { name: serviceName, version: serviceVersion },
            logRecords: [
              {
                timeUnixNano: now,
                observedTimeUnixNano: now,
                severityNumber: severity.number,
                severityText: severity.text,
                body: { stringValue: body },
                attributes: Object.entries(attributes ?? {}).map(([key, value]) => attr(key, normalizeAttribute(value))),
              },
            ],
          },
        ],
      },
    ],
  };

  await fetch(`${posthogHost}/i/v1/logs?token=${encodeURIComponent(posthogKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((error: unknown) => console.error("PostHog log export failed", error));
}

function severityFor(level: LogLevel): { text: "INFO" | "WARN" | "ERROR"; number: number } {
  if (level === "error") return { text: "ERROR", number: 17 };
  if (level === "warn") return { text: "WARN", number: 13 };
  return { text: "INFO", number: 9 };
}

function attr(key: string, value: unknown) {
  if (typeof value === "number" && Number.isInteger(value)) return { key, value: { intValue: value } };
  if (typeof value === "number") return { key, value: { doubleValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return { key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) } };
}

function normalizeAttribute(value: unknown): string | number | boolean | null {
  if (value instanceof Error) return JSON.stringify({ name: value.name, message: value.message, stack: value.stack });
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  return JSON.stringify(value);
}

function httpHost(host: string): string {
  return trimTrailingSlash(host.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://"));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal: NodeJS.Signals) {
  await logInfo("PostHog sidecar stopping", { signal, database: databaseName });
  await posthog.shutdown();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch(async (error: unknown) => {
  posthog.captureException(error, serviceName, { service: serviceName, database: databaseName });
  await logError("PostHog sidecar crashed", { database: databaseName, error: normalizeAttribute(error) });
  await posthog.shutdown();
  process.exit(1);
});
