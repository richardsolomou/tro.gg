/**
 * Bot-swarm load test against a SpacetimeDB instance (local by default).
 *
 * Every bot is a real SDK connection with the game client's subscription set,
 * wandering the world (click-to-move routes + WASD-style heading changes) and
 * chatting. The run reports connect health, move-ack latency (reducer call →
 * own row update), chat delivery latency (send → another bot's onInsert),
 * fan-out throughput, and the server process's CPU/RSS.
 *
 *   bin/loadtest                          # 100 bots, 60s, ws://localhost:3001
 *   bin/loadtest --bots 1100 --scatter    # scatter bots to random dry tiles (SQL DML)
 *   bin/loadtest --seconds 120 --light    # bots subscribe to player+chat only
 *
 * Bots shard across worker processes (--workers, default 1 per ~120 bots) so
 * one Node event loop never throttles the swarm. --scatter uses `spacetime sql`
 * UPDATEs (owner DML) to teleport the freshly spawned bots to random dry floor
 * before the measured window starts — it needs the CLI logged in to the target.
 */
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getZone, isDryFloor } from "../shared/index";
import { DbConnection } from "../src/net/module_bindings/index";

interface Args {
  bots: number;
  seconds: number;
  uri: string;
  db: string;
  workers: number;
  scatter: boolean;
  light: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const bots = Number(get("--bots") ?? 100);
  return {
    bots,
    seconds: Number(get("--seconds") ?? 60),
    uri: get("--uri") ?? "ws://localhost:3001",
    db: get("--db") ?? "trogg",
    workers: Number(get("--workers") ?? Math.max(1, Math.ceil(bots / 120))),
    scatter: argv.includes("--scatter"),
    light: argv.includes("--light"),
  };
}

const ZONE = "world";
const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

function quantiles(xs: number[]): string {
  if (xs.length === 0) return "none";
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return `n=${s.length} p50=${q(0.5).toFixed(0)}ms p95=${q(0.95).toFixed(0)}ms p99=${q(0.99).toFixed(0)}ms max=${s[s.length - 1]!.toFixed(0)}ms`;
}

// ── worker: run a batch of bots, report JSON on stdout ─────────────────────────

const DIRS = [
  { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
  { x: 1, y: 1 }, { x: -1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: -1 },
  { x: 0, y: 0 },
];
const PHRASES = ["onward", "sunny in the caves today", "hog!", "who took my pickaxe", "meet at the fords", "chop chop", "stone for sale"];
/** Cap latency samples per worker so a big swarm can't drown the harness in bookkeeping. */
const SAMPLE_CAP = 25_000;

async function runWorker(args: Args): Promise<void> {
  const count = Number(process.env.LOADTEST_COUNT ?? 0);
  const zone = getZone(ZONE)!;
  // Set at "go": stamps older than this are replayed history from the capped
  // chat backlog (subscription snapshots re-insert them), not live deliveries.
  let measureStart = Infinity;
  const moveAcks: number[] = [];
  const chatLatencies: number[] = [];
  const identities: string[] = [];
  let connectErrors = 0;
  let disconnects = 0;
  let rowUpdates = 0;
  let chatSent = 0;

  const queries = args.light
    ? [`SELECT * FROM player WHERE zone_id = '${ZONE}' AND online = true`, `SELECT * FROM chat_message WHERE zone_id = '${ZONE}'`]
    : [
        `SELECT * FROM player WHERE zone_id = '${ZONE}' AND online = true`,
        `SELECT * FROM chat_message WHERE zone_id = '${ZONE}'`,
        `SELECT * FROM ground_item WHERE zone_id = '${ZONE}'`,
        `SELECT * FROM boulder WHERE zone_id = '${ZONE}'`,
        `SELECT * FROM tree WHERE zone_id = '${ZONE}'`,
        `SELECT * FROM hog WHERE zone_id = '${ZONE}'`,
      ];

  const starters: (() => () => void)[] = [];
  const bot = (): Promise<void> =>
    new Promise((resolve) => {
      let myHex = "";
      let pending: { dirX: number; dirY: number; at: number } | null = null;
      DbConnection.builder()
        .withUri(args.uri)
        .withDatabaseName(args.db)
        .onConnect((conn, identity) => {
          myHex = identity.toHexString();
          identities.push(myHex);
          conn.db.player.onUpdate((_ctx, _old, row) => {
            rowUpdates++;
            if (pending && row.identity.toHexString() === myHex && row.dirX === pending.dirX && row.dirY === pending.dirY) {
              if (moveAcks.length < SAMPLE_CAP) moveAcks.push(Date.now() - pending.at);
              pending = null;
            }
          });
          conn.db.player.onInsert(() => rowUpdates++);
          if (!args.light) conn.db.hog.onUpdate(() => rowUpdates++);
          conn.db.chatMessage.onInsert((_ctx, row) => {
            rowUpdates++;
            const m = /@(\d{13})$/.exec(row.text);
            if (m && Number(m[1]) >= measureStart && row.sender.toHexString() !== myHex && chatLatencies.length < SAMPLE_CAP) {
              chatLatencies.push(Date.now() - Number(m[1]));
            }
          });
          conn
            .subscriptionBuilder()
            .onApplied(() => {
              starters.push(() => {
                const timers: ReturnType<typeof setInterval>[] = [];
                const roam = () => conn.reducers.moveTo({ x: Math.floor(rnd(1, zone.width - 1)), y: Math.floor(rnd(1, zone.height - 1)), running: Math.random() < 0.3 });
                setTimeout(roam, rnd(0, 2000));
                timers.push(setInterval(roam, rnd(6000, 12000)));
                timers.push(
                  setInterval(() => {
                    const d = pick(DIRS);
                    pending = { dirX: d.x, dirY: d.y, at: Date.now() };
                    conn.reducers.move({ dirX: d.x, dirY: d.y, running: false });
                  }, rnd(2000, 5000)),
                );
                timers.push(
                  setInterval(() => {
                    chatSent++;
                    conn.reducers.chat({ text: `${pick(PHRASES)} @${Date.now()}` });
                  }, rnd(6000, 15000)),
                );
                return () => {
                  for (const t of timers) clearInterval(t);
                  conn.disconnect();
                };
              });
              resolve();
            })
            .subscribe(queries);
        })
        .onConnectError(() => {
          connectErrors++;
          resolve();
        })
        .onDisconnect(() => disconnects++)
        .build();
    });

  for (let i = 0; i < count; i += 10) {
    await Promise.all(Array.from({ length: Math.min(10, count - i) }, bot));
  }
  process.stdout.write(JSON.stringify({ type: "ready", identities, connectErrors }) + "\n");

  await new Promise<void>((resolve) => {
    process.stdin.on("data", (chunk) => {
      if (chunk.toString().includes("go")) resolve();
    });
  });

  measureStart = Date.now();
  const stops = starters.map((start) => start());
  await new Promise((r) => setTimeout(r, args.seconds * 1000));
  process.stdout.write(JSON.stringify({ type: "result", moveAcks, chatLatencies, rowUpdates, chatSent, disconnects }) + "\n");
  for (const stop of stops) stop();
  setTimeout(() => process.exit(0), 1000);
}

// ── parent: shard workers, scatter, sample the server, aggregate ───────────────

/** Teleport each bot to a random dry tile via owner SQL DML, pooled over the CLI. */
async function scatter(args: Args, identities: string[]): Promise<number> {
  const zone = getZone(ZONE)!;
  const httpUri = args.uri.replace(/^ws/, "http");
  const randomDryTile = (): { x: number; y: number } => {
    for (;;) {
      const x = Math.floor(rnd(1, zone.width - 1));
      const y = Math.floor(rnd(1, zone.height - 1));
      if (isDryFloor(zone, x, y)) return { x, y };
    }
  };
  let placed = 0;
  const run = (hex: string): Promise<void> =>
    new Promise((resolve) => {
      const t = randomDryTile();
      execFile(
        "spacetime",
        ["sql", "--server", httpUri, args.db, `UPDATE player SET x = ${t.x}.0, y = ${t.y}.0 WHERE identity = 0x${hex}`],
        (err) => {
          if (!err) placed++;
          resolve();
        },
      );
    });
  const queue = [...identities];
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      for (let hex = queue.pop(); hex; hex = queue.pop()) await run(hex);
    }),
  );
  return placed;
}

async function sampleServer(seconds: number): Promise<string[]> {
  const pid = await new Promise<string>((resolve) => {
    execFile("pgrep", ["-f", "spacetimedb-standalone|spacetime start"], (_err, out) => resolve(out.split("\n")[0] ?? ""));
  });
  if (!pid) return ["server process not found (remote target?)"];
  const samples: string[] = [];
  for (let i = 0; i < Math.max(1, Math.floor(seconds / 5)); i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const line = await new Promise<string>((resolve) => {
      execFile("ps", ["-o", "%cpu,rss", "-p", pid], (_err, out) => resolve(out.trim().split("\n").pop() ?? ""));
    });
    const [cpu, rss] = line.trim().split(/\s+/);
    if (cpu && rss) samples.push(`cpu=${cpu}% rss=${Math.round(Number(rss) / 1024)}MB`);
  }
  return samples;
}

async function runParent(args: Args): Promise<void> {
  const self = fileURLToPath(import.meta.url);
  const perWorker = Math.ceil(args.bots / args.workers);
  console.log(`launching ${args.bots} bots across ${args.workers} workers against ${args.uri}/${args.db} (${args.light ? "light" : "full"} subscriptions)`);

  const t0 = Date.now();
  const workers = Array.from({ length: args.workers }, (_, i) => {
    const count = Math.min(perWorker, args.bots - i * perWorker);
    return spawn(process.execPath, ["--import", "tsx", self, ...process.argv.slice(2)], {
      env: { ...process.env, LOADTEST_ROLE: "worker", LOADTEST_COUNT: String(count) },
      stdio: ["pipe", "pipe", "inherit"],
    });
  });

  const identities: string[] = [];
  let connectErrors = 0;
  const results: { moveAcks: number[]; chatLatencies: number[]; rowUpdates: number; chatSent: number; disconnects: number }[] = [];
  const done = workers.map(
    (w) =>
      new Promise<void>((resolve) => {
        let buffer = "";
        w.stdout.on("data", (chunk) => {
          buffer += chunk.toString();
          let nl;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith("{")) continue;
            const msg = JSON.parse(line);
            if (msg.type === "ready") {
              identities.push(...msg.identities);
              connectErrors += msg.connectErrors;
            } else if (msg.type === "result") {
              results.push(msg);
              resolve();
            }
          }
        });
        w.on("exit", () => resolve());
      }),
  );

  // wait for every worker's ready line
  while (identities.length + connectErrors < args.bots) await new Promise((r) => setTimeout(r, 250));
  console.log(`connected ${identities.length}/${args.bots} in ${Date.now() - t0}ms (${connectErrors} errors)`);

  if (args.scatter) {
    const t1 = Date.now();
    const placed = await scatter(args, identities);
    console.log(`scattered ${placed}/${identities.length} bots to random dry tiles in ${Date.now() - t1}ms`);
  }

  console.log(`measuring for ${args.seconds}s…`);
  for (const w of workers) w.stdin.write("go\n");
  const serverSamples = await sampleServer(args.seconds);
  await Promise.all(done);

  const moveAcks = results.flatMap((r) => r.moveAcks);
  const chatLatencies = results.flatMap((r) => r.chatLatencies);
  const rowUpdates = results.reduce((a, r) => a + r.rowUpdates, 0);
  const chatSent = results.reduce((a, r) => a + r.chatSent, 0);
  const disconnects = results.reduce((a, r) => a + r.disconnects, 0);
  console.log("--- results ---");
  console.log(`bots: ${identities.length}/${args.bots} connected, ${disconnects} mid-run disconnects`);
  console.log(`move ack:      ${quantiles(moveAcks)}`);
  console.log(`chat delivery: ${quantiles(chatLatencies)} (${chatSent} sent; sampled, capped per worker)`);
  console.log(`row updates received across all bots: ${rowUpdates} (${Math.round(rowUpdates / args.seconds)}/s)`);
  console.log(`server: ${serverSamples.join(" | ")}`);
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
if (process.env.LOADTEST_ROLE === "worker") await runWorker(args);
else await runParent(args);
