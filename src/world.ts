import { Application, Container, Graphics, Text } from "pixi.js";
import { CHAT_BUBBLE_MS, getZone, projectMotion, STARTING_ZONE_SLUG, troggColor } from "@trogg/shared";
import type { DbConnection } from "./module_bindings";
import type { Player } from "./module_bindings/types";
import { attachKeyboard } from "./input.js";
import { mountChat } from "./chat.js";
import { createTerrain } from "./terrain.js";
import { captureEvent, isFeatureEnabled } from "./analytics.js";
import { Avatar, type AvatarSheets, loadAvatarSheets } from "./avatars.js";

/** Art pixels per tile — terrain tiles are drawn at this and scaled up crisply. */
const ART = 16;
/** Fraction of the viewport the zone fills, leaving a rim of cave around it. */
const ZONE_FILL = 0.92;
/** Screen pixels per tile, sized to the viewport in `layout`. */
let TILE = 28;

/** A player's marker plus the client-clock instant its current intent arrived. */
interface Tracked {
  marker: Container;
  avatar?: Avatar;
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
export async function mountWorld(app: Application, conn: DbConnection) {
  const slug = STARTING_ZONE_SLUG;
  const zone = getZone(slug)!;
  const bounds = { width: zone.width, height: zone.height };
  const myId = conn.identity?.toHexString();

  // Sprite avatars ship behind a flag (invariant 5); if the flag is on but the
  // sheets fail to load, fall back to the placeholder marker rather than nothing.
  let sheets: AvatarSheets | undefined;
  if (isFeatureEnabled("avatar-sprites")) {
    try {
      sheets = await loadAvatarSheets();
    } catch (err) {
      console.warn("Avatar sprites failed to load; using placeholder markers.", err);
    }
  }

  const terrain = createTerrain(bounds.width, bounds.height);
  const stage = new Container();
  // Background rock fills the screen behind the zone; the stage carries the
  // floor + walls + markers and is centred; the vignette darkens the edges on top.
  app.stage.addChild(terrain.background, stage, terrain.vignette);
  stage.addChild(terrain.ground);

  const tracked = new Map<string, Tracked>();

  const layout = () => {
    const { width: vw, height: vh } = app.renderer;
    const fit = Math.min((vw * ZONE_FILL) / bounds.width, (vh * ZONE_FILL) / bounds.height);
    TILE = Math.max(ART, Math.floor(fit));
    terrain.layout(TILE, vw, vh);
    centre(app, stage, bounds.width, bounds.height);
    // Markers bake TILE into their size at creation, so resize redraws them.
    for (const [id, entry] of tracked) rebuildMarker(id, entry);
  };

  const rebuildMarker = (id: string, entry: Tracked) => {
    if (entry.bubbleTimer) clearTimeout(entry.bubbleTimer);
    entry.marker.destroy({ children: true });
    // Markers (and their sprite avatars) bake the current TILE into their size,
    // so a resize rebuilds both — re-point entry.avatar at the fresh one.
    const { marker, avatar } = makeMarker(entry.player.name, troggColor(id), id === myId, sheets);
    entry.marker = marker;
    entry.avatar = avatar;
    entry.bubble = undefined;
    entry.bubbleTimer = undefined;
    stage.addChild(entry.marker);
  };

  app.renderer.on("resize", layout);
  layout();

  const addPlayer = (p: Player) => {
    const id = p.identity.toHexString();
    if (tracked.has(id)) return;
    const { marker, avatar } = makeMarker(p.name, troggColor(id), id === myId, sheets);
    const entry: Tracked = { marker, avatar, player: p, baseMs: performance.now() };
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
      // Face travel direction and walk while moving (cheap; only re-rigs on change).
      entry.avatar?.setMotion(entry.player.dirX, entry.player.dirY);
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

function makeMarker(name: string, color: number, self: boolean, sheets?: AvatarSheets) {
  const marker = new Container();

  // Sprite avatar when the sheets loaded; otherwise the placeholder colour
  // marker (GDD "Placeholder rendering"). Players are troggs; Hogs are NPCs.
  let avatar: Avatar | undefined;
  if (sheets) {
    avatar = new Avatar(sheets.trogg, color, self, TILE);
    marker.addChild(avatar.view);
  } else {
    const body = new Graphics().rect(2, 2, TILE - 4, TILE - 4).fill(color);
    // Your own trogg keeps its colour but gets an outline so you can pick it out.
    if (self) body.rect(2, 2, TILE - 4, TILE - 4).stroke({ width: 2, color: 0xe8dcc4 });
    marker.addChild(body);
  }

  const label = new Text({
    text: name,
    style: { fontFamily: "monospace", fontSize: 11, fill: 0xe8dcc4 },
  });
  label.anchor.set(0.5, 1);
  label.position.set(TILE / 2, -2);
  marker.addChild(label);
  return { marker, avatar };
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
