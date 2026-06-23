import { Application, Container, Graphics, Text } from "pixi.js";
import { CHAT_BUBBLE_MS, getZone, projectMotion, STARTING_ZONE_SLUG, troggColor } from "@trogg/shared";
import type { DbConnection } from "./module_bindings";
import type { Player } from "./module_bindings/types";
import { attachKeyboard } from "./input.js";
import { mountChat } from "./chat.js";
import { captureEvent, isFeatureEnabled } from "./analytics.js";

const TILE = 28;

/** A player's marker plus the client-clock instant its current intent arrived. */
interface Tracked {
  marker: Container;
  player: Player;
  baseMs: number;
  bubble?: Container;
  bubbleTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Renders the zone: a tile grid plus a marker per player. Movement is intent-
 * based (GDD "Movement") — the `player` table syncs each trogg's origin,
 * direction, and start time, and every client extrapolates position locally each
 * frame so motion is smooth without per-frame server sync (invariant 2). Zone
 * dimensions come from the static `ZONES` registry (shared by client and module).
 * PixiJS is the renderer per the GDD "Camera and rendering" section.
 */
export function mountWorld(app: Application, conn: DbConnection) {
  const slug = STARTING_ZONE_SLUG;
  const zone = getZone(slug)!;
  const bounds = { width: zone.width, height: zone.height };
  const myId = conn.identity?.toHexString();

  const stage = new Container();
  app.stage.addChild(stage);
  const grid = new Graphics();
  stage.addChild(grid);

  const layout = () => {
    drawGrid(grid, bounds.width, bounds.height);
    centre(app, stage, bounds.width, bounds.height);
  };
  app.renderer.on("resize", layout);
  layout();

  const tracked = new Map<string, Tracked>();

  const addPlayer = (p: Player) => {
    const id = p.identity.toHexString();
    if (tracked.has(id)) return;
    const marker = makeMarker(p.name, troggColor(id), id === myId);
    const entry: Tracked = { marker, player: p, baseMs: performance.now() };
    place(marker, p.x, p.y);
    tracked.set(id, entry);
    stage.addChild(marker);
  };

  const removePlayer = (id: string) => {
    const entry = tracked.get(id);
    if (entry?.bubbleTimer) clearTimeout(entry.bubbleTimer);
    entry?.marker.destroy({ children: true });
    tracked.delete(id);
  };

  conn.db.player.onInsert((_ctx, p) => addPlayer(p));
  conn.db.player.onUpdate((_ctx, _old, p) => {
    const entry = tracked.get(p.identity.toHexString());
    if (!entry) return addPlayer(p);
    // Rebase extrapolation on every new intent so elapsed is measured in client
    // time — no server-clock sync needed, and each update reconciles drift.
    entry.player = p;
    entry.baseMs = performance.now();
  });
  conn.db.player.onDelete((_ctx, p) => removePlayer(p.identity.toHexString()));

  app.ticker.add(() => {
    const now = performance.now();
    for (const entry of tracked.values()) {
      const { x, y } = projectMotion(entry.player, now - entry.baseMs, bounds);
      place(entry.marker, x, y);
    }
  });

  attachKeyboard(conn);

  // Live once the initial rows have been delivered: backlog chat fills the
  // history panel silently, while later inserts also pop a bubble.
  const sub = { live: false };
  if (isFeatureEnabled("chat-enabled")) setupChat(conn, tracked, slug, sub, myId);

  conn
    .subscriptionBuilder()
    .onApplied(() => (sub.live = true))
    .subscribe([
      `SELECT * FROM player WHERE zone_id = '${slug}' AND online = true`,
      `SELECT * FROM chat_message WHERE zone_id = '${slug}'`,
    ]);
}

/**
 * Wires zone chat: every `chat_message` row feeds the side-panel history (the
 * subscription replays recent lines on join), and once live, a new row also pops
 * a bubble over the speaker's head — so bubbles fire only for present players,
 * not the backlog. Own messages emit `chat_sent` — never content (invariant 4 /
 * docs/analytics.md).
 */
function setupChat(
  conn: DbConnection,
  tracked: Map<string, Tracked>,
  slug: string,
  sub: { live: boolean },
  myId: string | undefined,
) {
  const chat = mountChat((text) => {
    conn.reducers.chat({ text });
  });

  conn.db.chatMessage.onInsert((_ctx, message) => {
    const senderId = message.sender.toHexString();
    chat.addMessage(message.name, message.text, troggColor(senderId));
    // Bubble only for fresh lines: a reconnect replays the zone's recent history,
    // and those rows can arrive after the subscription goes live — without this an
    // old message would pop a stale bubble over its sender on every refresh.
    const ageMs = Date.now() - Number(message.createdAt.microsSinceUnixEpoch / 1000n);
    if (ageMs > CHAT_BUBBLE_MS) return;
    showBubble(tracked, senderId, message.text);
    if (sub.live && senderId === myId) captureEvent("chat_sent", { zone: slug });
  });
}

/** Pop a speech bubble over a trogg's head, replacing any current one. */
function showBubble(tracked: Map<string, Tracked>, id: string, text: string) {
  const entry = tracked.get(id);
  if (!entry) return;

  if (entry.bubbleTimer) clearTimeout(entry.bubbleTimer);
  entry.bubble?.destroy({ children: true });

  const bubble = makeBubble(text);
  entry.marker.addChild(bubble);
  entry.bubble = bubble;
  entry.bubbleTimer = setTimeout(() => {
    bubble.destroy({ children: true });
    if (entry.bubble === bubble) {
      entry.bubble = undefined;
      entry.bubbleTimer = undefined;
    }
  }, CHAT_BUBBLE_MS);
}

function makeBubble(text: string): Container {
  const bubble = new Container();
  const label = new Text({
    text,
    style: { fontFamily: "monospace", fontSize: 11, fill: 0x0a0806, align: "center", wordWrap: true, wordWrapWidth: 150 },
  });
  label.anchor.set(0.5, 1);
  const padX = 5;
  const padY = 3;
  const bg = new Graphics()
    .roundRect(-label.width / 2 - padX, -label.height - padY, label.width + padX * 2, label.height + padY * 2, 4)
    .fill(0xe8dcc4);
  label.position.set(0, padY);
  bubble.addChild(bg, label);
  bubble.position.set(TILE / 2, -16);
  return bubble;
}

function drawGrid(g: Graphics, width: number, height: number) {
  g.clear();
  for (let x = 0; x <= width; x++) {
    g.moveTo(x * TILE, 0).lineTo(x * TILE, height * TILE);
  }
  for (let y = 0; y <= height; y++) {
    g.moveTo(0, y * TILE).lineTo(width * TILE, y * TILE);
  }
  g.stroke({ width: 1, color: 0x2a2118 });
}

function makeMarker(name: string, color: number, self: boolean) {
  const marker = new Container();
  const body = new Graphics().rect(2, 2, TILE - 4, TILE - 4).fill(color);
  // Your own trogg keeps its colour but gets an outline so you can pick it out.
  if (self) body.rect(2, 2, TILE - 4, TILE - 4).stroke({ width: 2, color: 0xe8dcc4 });
  const label = new Text({
    text: name,
    style: { fontFamily: "monospace", fontSize: 11, fill: 0xe8dcc4 },
  });
  label.anchor.set(0.5, 1);
  label.position.set(TILE / 2, -2);
  marker.addChild(body, label);
  return marker;
}

function place(marker: Container, x: number, y: number) {
  marker.position.set(x * TILE, y * TILE);
}

function centre(app: Application, stage: Container, width: number, height: number) {
  stage.position.set(
    (app.renderer.width - width * TILE) / 2,
    (app.renderer.height - height * TILE) / 2,
  );
}
