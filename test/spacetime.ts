// An in-memory fake of the SpacetimeDB reducer `ctx`, faithful to the table API the
// reducers actually use: per-table `insert`/`iter`/`count`/`clear` and per-index
// `find`/`filter`/`update`/`delete`. Tests seed rows, call a reducer with this ctx, then
// assert on the resulting rows. The risk in any fake-db harness is the CRUD semantics
// drifting from the real store; these are the unambiguous ones the reducers rely on.

import { neighborsOf, regionSlug } from "@trogg/shared";

/** A stand-in identity: equality by hex, like SpacetimeDB's Identity. */
export interface Id {
  readonly hex: string;
  toHexString(): string;
  isEqual(other: Id): boolean;
}

export function id(hex: string): Id {
  return { hex, toHexString: () => hex, isEqual: (o: Id) => !!o && o.hex === hex };
}

const eq = (a: unknown, b: unknown): boolean =>
  a != null && typeof (a as Id).isEqual === "function" ? (a as Id).isEqual(b as Id) : a === b;

interface TableConfig {
  pk: string;
  indexes?: string[];
  autoInc?: boolean;
}

function makeTable(cfg: TableConfig) {
  let rows: any[] = [];
  let nextId = 1n;
  const accessor = (col: string) => ({
    find: (key: unknown) => rows.find((r) => eq(r[col], key)),
    filter: (key: unknown) => rows.filter((r) => eq(r[col], key)),
    update: (row: any) => {
      const i = rows.findIndex((r) => eq(r[col], row[col]));
      if (i >= 0) rows[i] = row;
    },
    delete: (key: unknown) => {
      rows = rows.filter((r) => !eq(r[col], key));
    },
  });

  const table: any = {
    insert: (row: any) => {
      const r = cfg.autoInc && (row[cfg.pk] === 0n || row[cfg.pk] === 0) ? { ...row, [cfg.pk]: nextId++ } : { ...row };
      rows.push(r);
      return r;
    },
    iter: () => [...rows],
    count: () => rows.length,
    clear: () => {
      rows = [];
    },
    rows: () => rows,
  };
  table[cfg.pk] = accessor(cfg.pk);
  for (const idx of cfg.indexes ?? []) table[idx] = accessor(idx);
  return table;
}

export interface FakeCtxOpts {
  sender: Id;
  connectionId?: Id | null;
  /** Microseconds since epoch for `ctx.timestamp`. */
  now?: bigint;
  /** JWT issuer — set to the SpacetimeAuth issuer to act as an authed account caller. */
  issuer?: string;
  jwtPayload?: Record<string, unknown>;
  /** Deterministic RNG: `random()` and `random.integerInRange(lo, hi)`. */
  random?: number;
  integerInRange?: (lo: number, hi: number) => number;
}

export function makeCtx(opts: FakeCtxOpts) {
  const randomValue = opts.random ?? 0.5;
  const random: any = () => randomValue;
  random.integerInRange = opts.integerInRange ?? ((lo: number) => lo);

  // A generous block of regions around the origin starts claimed, so existing
  // movement/combat/interact tests (written before the lazy-reveal frontier
  // existed) see all the ground they use as walkable. A test exercising the
  // frontier itself clears this table down to whichever regions the scenario
  // calls for.
  const revealedRegion = makeTable({ pk: "slug" });
  for (let cellY = -3; cellY <= 3; cellY++) {
    for (let cellX = -3; cellX <= 3; cellX++) {
      const slug = regionSlug(cellX, cellY);
      revealedRegion.insert({ slug, name: slug, interior: true, revealedAt: { microsSinceUnixEpoch: 0n } });
    }
  }

  return {
    sender: opts.sender,
    connectionId: opts.connectionId ?? id("conn"),
    timestamp: { microsSinceUnixEpoch: opts.now ?? 0n },
    senderAuth: {
      hasJWT: opts.issuer != null,
      jwt: opts.issuer != null ? { issuer: opts.issuer, fullPayload: opts.jwtPayload ?? {} } : undefined,
    },
    random,
    db: {
      player: makeTable({ pk: "identity", indexes: ["zoneId"] }),
      boulder: makeTable({ pk: "id", autoInc: true, indexes: ["zoneId"] }),
      tree: makeTable({ pk: "id", autoInc: true, indexes: ["zoneId"] }),
      darkCreature: makeTable({ pk: "id", autoInc: true, indexes: ["zoneId"] }),
      groundItem: makeTable({ pk: "id", autoInc: true, indexes: ["zoneId"] }),
      inventory: makeTable({ pk: "id", autoInc: true, indexes: ["playerId"] }),
      skills: makeTable({ pk: "id", autoInc: true, indexes: ["playerId"] }),
      stockpile: makeTable({ pk: "item" }),
      brazier: makeTable({ pk: "id", autoInc: true, indexes: ["zoneId"] }),
      brazierUpkeepTimer: makeTable({ pk: "scheduledId", autoInc: true }),
      afkWanderTimer: makeTable({ pk: "scheduledId", autoInc: true }),
      playerConnection: makeTable({ pk: "connectionId", indexes: ["playerId"] }),
      chatMessage: makeTable({ pk: "id", autoInc: true, indexes: ["zoneId"] }),
      ghostHaunt: makeTable({ pk: "id", autoInc: true, indexes: ["zoneId"] }),
      claimCode: makeTable({ pk: "code" }),
      playerRespawn: makeTable({ pk: "scheduledId", autoInc: true, indexes: ["playerId"] }),
      nodeRespawn: makeTable({ pk: "scheduledId", autoInc: true }),
      worldState: makeTable({ pk: "id" }),
      creatureRegen: makeTable({ pk: "scheduledId", autoInc: true }),
      revealedRegion,
    },
  };
}

export type FakeCtx = ReturnType<typeof makeCtx>;

/** Build a player row with sensible defaults; override what the test cares about. */
export function playerRow(identity: Id, over: Record<string, unknown> = {}) {
  return {
    identity,
    zoneId: "world",
    name: "trogg-0000",
    color: -1,
    x: 5,
    y: 5,
    dirX: 0,
    dirY: 0,
    faceX: 0,
    faceY: 1,
    running: false,
    path: "",
    carrying: "",
    carryingStyle: "",
    equippedMainHand: "",
    equippedMainHandInventoryId: 0n,
    equipmentAction: "",
    equipmentActionAt: { microsSinceUnixEpoch: 0n },
    style: -1,
    health: 100,
    dead: false,
    respawnAt: undefined,
    online: true,
    isGuest: true,
    movedAt: { microsSinceUnixEpoch: 0n },
    lastChatAt: undefined,
    cheatSpeed: 1,
    cheatFly: false,
    cheatInvulnerable: false,
    cheatNoclip: false,
    z: 0,
    dirZ: 0,
    kindlingCharge: 0,
    kindlingChargeAt: { microsSinceUnixEpoch: 0n },
    ...over,
  };
}

/** Build a dark creature row with sensible defaults; override what the test cares about. */
export function darkCreatureRow(over: Record<string, unknown> = {}) {
  return {
    id: 0n,
    zoneId: "world",
    x: 5,
    y: 5,
    dirX: 0,
    dirY: 0,
    movedAt: { microsSinceUnixEpoch: 0n },
    species: "grask",
    health: 40,
    lastDamagedAt: { microsSinceUnixEpoch: 0n },
    aggroTargetId: "",
    ...over,
  };
}

/** Build a claimed-region row with sensible defaults; override what the test cares about. */
export function revealedRegionRow(over: Record<string, unknown> = {}) {
  return {
    slug: "hearth",
    name: "The Hearth",
    interior: true,
    revealedAt: { microsSinceUnixEpoch: 0n },
    ...over,
  };
}
