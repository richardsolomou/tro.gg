import { Application, Container, Graphics, Text } from "pixi.js";
import { getStateCallbacks, type Room } from "@colyseus/sdk";
import {
  CHAT_BUBBLE_MS,
  type ChatBubblePayload,
  ClientMessage,
  projectMotion,
  ServerMessage,
  type Player,
  type ZoneState,
} from "@trogg/shared";
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
 * based (GDD "Movement") — the room syncs each trogg's origin, direction, and
 * start time, and every client extrapolates position locally each frame so motion
 * is smooth without per-frame server sync (invariant 2). PixiJS is the renderer
 * per the GDD "Camera and rendering" section.
 */
export function mountWorld(app: Application, room: Room<ZoneState>) {
  const stage = new Container();
  app.stage.addChild(stage);

  const grid = new Graphics();
  stage.addChild(grid);

  // Zone dimensions ride the room state and arrive in the first patch just after
  // join (not at join itself), so draw the grid and centre the stage once they
  // are known — and again on resize.
  const layout = () => {
    drawGrid(grid, room.state.width, room.state.height);
    centre(app, stage, room.state.width, room.state.height);
  };
  app.renderer.on("resize", layout);
  if (room.state.width > 0) layout();
  else room.onStateChange.once(layout);

  const tracked = new Map<string, Tracked>();
  const $ = getStateCallbacks(room);

  $(room.state).players.onAdd((player, sessionId) => {
    const marker = makeMarker(player.name, player.color, sessionId === room.sessionId);
    const entry: Tracked = { marker, player, baseMs: performance.now() };
    place(marker, player.x, player.y);
    tracked.set(sessionId, entry);
    stage.addChild(marker);
    // Rebase extrapolation on every new intent so elapsed is measured in client
    // time — no server-clock sync needed, and each diff reconciles drift.
    $(player).onChange(() => (entry.baseMs = performance.now()));
  });

  $(room.state).players.onRemove((_player, sessionId) => {
    const entry = tracked.get(sessionId);
    if (entry?.bubbleTimer) clearTimeout(entry.bubbleTimer);
    entry?.marker.destroy({ children: true });
    tracked.delete(sessionId);
  });

  app.ticker.add(() => {
    const now = performance.now();
    const bounds = { width: room.state.width, height: room.state.height };
    for (const { marker, player, baseMs } of tracked.values()) {
      const { x, y } = projectMotion(player, now - baseMs, bounds);
      place(marker, x, y);
    }
  });

  const detachKeyboard = attachKeyboard(room);
  room.onLeave(() => detachKeyboard());

  if (isFeatureEnabled("chat-enabled")) setupChat(room, tracked, $);
}

/**
 * Wires zone chat: the synced history feeds the side panel (replayed on join),
 * while live bubbles arrive as broadcasts so they pop only for present players,
 * not for the backlog. Own confirmed messages emit `chat_sent` — never content
 * (invariant 4 / docs/analytics.md).
 */
function setupChat(room: Room<ZoneState>, tracked: Map<string, Tracked>, $: ReturnType<typeof getStateCallbacks>) {
  const chat = mountChat((text) => room.send(ClientMessage.Chat, { text }));

  $(room.state).chat.onAdd((message) => chat.addMessage(message.name, message.text, message.color));

  room.onMessage(ServerMessage.ChatBubble, ({ sessionId, text }: ChatBubblePayload) => {
    showBubble(tracked, sessionId, text);
    if (sessionId === room.sessionId) captureEvent("chat_sent", { zone: room.state.slug });
  });

  room.onLeave(() => chat.destroy());
}

/** Pop a speech bubble over a trogg's head, replacing any current one. */
function showBubble(tracked: Map<string, Tracked>, sessionId: string, text: string) {
  const entry = tracked.get(sessionId);
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
