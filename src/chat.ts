import { Application, Container, Graphics, Rectangle, Text } from "pixi.js";
import { CHAT_BUBBLE_MS, CHAT_HISTORY_MAX, CHAT_MAX_CHARS, COLOR_UNSET, timestampMs, troggColorFor, type Zone } from "@trogg/shared";
import type { DbConnection } from "./module_bindings";
import type { Player } from "./module_bindings/types";
import { createTextField } from "./input_field.js";
import { blurTextInput, focusTextInput, isTextInputActive } from "./text_input.js";
import { TEXT_RESOLUTION } from "./ui_text.js";
import { handleChatCommand } from "./chat_commands.js";
import { captureEvent, isFeatureEnabled } from "./analytics.js";
import { audio } from "./audio.js";
import type { Entities, Tracked } from "./entities.js";

export interface ChatUI {
  /** Append a line to the side-panel history, the name tinted by `color` (0xRRGGBB). */
  addMessage(senderId: string, name: string, text: string, color: number): void;
  /** Rewrite the displayed name on every history line from `senderId` (a rename). */
  renameSender(senderId: string, name: string): void;
  /** Retint the name on every history line from `senderId` (a recolour). */
  recolorSender(senderId: string, color: number): void;
  destroy(): void;
}

type ChatLine = {
  senderId: string;
  name: string;
  text: string;
  color: number;
};

const PAD = 12;
const FONT = "monospace";
const INK = 0xe8dcc4;
const MUTED = 0x9b8a6c;
const PANEL = 0x0a0806;
const BORDER = 0x2a2118;
const LINE_H = 19;

/**
 * The visible chat history and input are Pixi HUD elements so they resize with the
 * game renderer. A tiny hidden DOM input still owns actual typing while focused,
 * because mobile keyboards, paste, and IME composition belong to the browser.
 */
export function mountChat(app: Application, send: (text: string) => void): ChatUI {
  const root = new Container();
  root.zIndex = 100;
  app.stage.sortableChildren = true;
  app.stage.addChild(root);

  const logBg = new Graphics();
  const logContent = new Container();
  const inputBox = new Graphics();
  const inputField = createTextField({ ticker: app.ticker, fontSize: 13, ink: INK, muted: MUTED });

  root.addChild(logBg, logContent, inputBox, inputField.view);

  const lines: ChatLine[] = [];
  let inputValue = "";
  let caret = 0;
  let focused = false;
  let width = 320;
  let logHeight = 140;
  let scroll = 0;
  let maxScroll = 0;
  let logRect = new Rectangle(0, 0, 0, 0);

  const setInput = (value: string, at = value.length) => {
    inputValue = value.slice(0, CHAT_MAX_CHARS);
    caret = Math.min(at, inputValue.length);
    renderInput();
  };

  const submit = (value: string) => {
    focused = false;
    const text = value.trim();
    setInput("");
    if (text) send(text);
  };

  const cancel = () => {
    focused = false;
    setInput("");
  };

  // Shell-style recall of sent messages. `cursor` indexes `sent`; when it
  // equals sent.length the input holds the live draft (preserved across recall).
  const sent: string[] = [];
  let cursor = 0;
  let draft = "";

  const recall = (delta: number, input: HTMLInputElement) => {
    if (!sent.length) return;
    if (cursor === sent.length) draft = input.value;
    cursor = Math.max(0, Math.min(sent.length, cursor + delta));
    const value = cursor === sent.length ? draft : sent[cursor]!;
    input.value = value;
    setInput(value);
    input.setSelectionRange(input.value.length, input.value.length);
  };

  const focus = () => {
    focused = true;
    renderInput();
    focusTextInput({
      value: inputValue,
      maxLength: CHAT_MAX_CHARS,
      onChange: setInput,
      onSubmit(value) {
        const text = value.trim();
        if (text && sent[sent.length - 1] !== text) sent.push(text);
        cursor = sent.length;
        draft = "";
        submit(value);
      },
      onCancel: cancel,
      onBlur() {
        focused = false;
        renderInput();
      },
      onKeyDown(e, input) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          recall(-1, input);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          recall(1, input);
        }
      },
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || isTextInputActive()) return;
    e.preventDefault();
    focus();
  };

  const onWheel = (e: WheelEvent) => {
    if (!logRect.contains(e.clientX, e.clientY) || maxScroll <= 0) return;
    e.preventDefault();
    scroll = Math.max(0, Math.min(maxScroll, scroll + e.deltaY));
    renderMessages();
  };

  const layout = () => {
    const vw = app.screen.width;
    const vh = app.screen.height;
    width = Math.min(340, Math.max(220, vw - PAD * 2));
    logHeight = Math.max(72, Math.min(Math.floor(vh * 0.3), vh - 142));
    root.position.set(PAD, vh - PAD - logHeight - 36);
    logRect = new Rectangle(root.x, root.y, width, logHeight);

    logBg.clear();
    drawPanel(logBg, 0, 0, width, logHeight, PANEL, 0.55);
    drawPanel(inputBox, 0, logHeight + 6, width, 30, PANEL, 0.82, BORDER);
    inputBox.eventMode = "static";
    inputBox.cursor = "text";
    inputBox.hitArea = new Rectangle(0, logHeight + 6, width, 30);
    inputBox.removeAllListeners("pointertap");
    inputBox.on("pointertap", focus);

    inputField.place(8, logHeight + 12, width - 16);
    renderMessages();
    renderInput();
  };

  function renderInput() {
    inputField.set({ value: inputValue, placeholder: "Press Enter to chat...", focused, caret });
    inputBox.clear();
    drawPanel(inputBox, 0, logHeight + 6, width, 30, PANEL, focused ? 0.92 : 0.82, focused ? INK : BORDER);
  }

  function renderMessages() {
    destroyChildren(logContent);

    const availableWidth = width - 16;
    const rendered = lines.map((line) => buildLine(line, availableWidth));
    const totalHeight = rendered.reduce((sum, row) => sum + row.height + 2, 0);
    maxScroll = Math.max(0, totalHeight - logHeight + 12);
    scroll = Math.max(0, Math.min(maxScroll, scroll));

    let y = 6 - scroll + Math.max(0, logHeight - totalHeight - 8);
    for (const row of rendered) {
      if (y + row.height < 0 || y > logHeight) {
        y += row.height + 2;
        row.container.destroy({ children: true });
        continue;
      }
      row.container.position.set(8, y);
      logContent.addChild(row.container);
      y += row.height + 2;
    }
  }

  function buildLine(line: ChatLine, availableWidth: number): { container: Container; height: number } {
    const row = new Container();
    const who = new Text({
      text: `${line.name}: `,
      style: { fontFamily: FONT, fontSize: 13, fill: line.color },
      resolution: TEXT_RESOLUTION,
    });
    const bodyWidth = Math.max(48, availableWidth - who.width);
    const body = new Text({
      text: line.text,
      style: {
        fontFamily: FONT,
        fontSize: 13,
        fill: INK,
        wordWrap: true,
        wordWrapWidth: bodyWidth,
        breakWords: true,
        lineHeight: LINE_H,
      },
      resolution: TEXT_RESOLUTION,
    });
    body.position.set(who.width, 0);
    row.addChild(who, body);
    return { container: row, height: Math.max(who.height, body.height) };
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("wheel", onWheel, { passive: false });
  app.renderer.on("resize", layout);
  layout();

  return {
    addMessage(senderId, name, text, color) {
      lines.push({ senderId, name, text, color });
      while (lines.length > CHAT_HISTORY_MAX) lines.shift();
      scroll = Number.POSITIVE_INFINITY;
      renderMessages();
    },
    renameSender(senderId, name) {
      for (const line of lines) if (line.senderId === senderId) line.name = name;
      renderMessages();
    },
    recolorSender(senderId, color) {
      for (const line of lines) if (line.senderId === senderId) line.color = color;
      renderMessages();
    },
    destroy() {
      blurTextInput();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onWheel);
      app.renderer.off("resize", layout);
      inputField.destroy();
      root.destroy({ children: true });
    },
  };
}

function drawPanel(g: Graphics, x: number, y: number, w: number, h: number, fill: number, alpha: number, stroke?: number): void {
  g.roundRect(x, y, w, h, 4).fill({ color: fill, alpha });
  if (stroke !== undefined) g.roundRect(x, y, w, h, 4).stroke({ width: 1, color: stroke });
}

function destroyChildren(container: Container): void {
  for (const child of container.removeChildren()) child.destroy({ children: true });
}

/**
 * Wires zone chat: every `chat_message` row feeds the side-panel history (the
 * subscription replays recent lines on join), and once live, a new row also pops
 * a bubble over the speaker's head — so bubbles fire only for present players,
 * not the backlog. Own messages emit `chat_sent` — never content (invariant 4 /
 * docs/analytics.md).
 */
export function setupChat(
  app: Application,
  conn: DbConnection,
  entities: Entities,
  tracked: Map<string, Tracked>,
  zone: Zone,
  sub: { live: boolean },
  myId: string | undefined,
  stage: Container,
) {
  const slug = zone.slug;
  // The `/spawn` debug command is typed in the chat box but isn't a chat line —
  // it spawns an entity at the caller's tile (server-authoritative) instead of
  // broadcasting. It has an optional flag; off → it's sent as plain chat.
  // Defaults on in local dev, off in a production build (PostHog can flip it on).
  const spawnEnabled = isFeatureEnabled("spawn-command", import.meta.env.DEV);
  // `/reset` snaps the zone's boulders (`boulder-reset`) or Hogs (`hog-reset`) back
  // to their registry layout; each target is independently gated, so bare `/reset`
  // and `/reset boulders` need boulders on, `/reset hedgehogs` needs Hogs on.
  const resetBouldersEnabled = isFeatureEnabled("boulder-reset");
  const resetHogsEnabled = isFeatureEnabled("hog-reset");
  // `/ghost` flickers the cosmetic ghost at a random tile; same flag as the launch
  // haunt (fallback on, so anyone can summon it), kept client-only.
  const ghostEnabled = isFeatureEnabled("ghost-trogg");
  const chat = mountChat(app, (text) => {
    const flags = { spawn: spawnEnabled, resetBoulders: resetBouldersEnabled, resetHogs: resetHogsEnabled, ghost: ghostEnabled };
    if (handleChatCommand(text, { conn, chat, zone, flags, onGhost: (tile) => entities.hauntGhost(stage, tile) })) return;
    audio.playChatSend();
    conn.reducers.chat({ text });
  });

  const senderColor = (sender: Player["identity"]) =>
    troggColorFor(conn.db.player.identity.find(sender)?.color ?? COLOR_UNSET, sender.toHexString());

  conn.db.chatMessage.onInsert((_ctx, message) => {
    const senderId = message.sender.toHexString();
    chat.addMessage(senderId, message.name, message.text, senderColor(message.sender));
    // Bubble only for fresh lines: a reconnect replays the zone's recent history,
    // and those rows can arrive after the subscription goes live — without this an
    // old message would pop a stale bubble over its sender on every refresh.
    const ageMs = Date.now() - timestampMs(message.createdAt);
    if (ageMs > CHAT_BUBBLE_MS) return;
    showBubble(entities, tracked, senderId, message.text);
    if (!sub.live) return;
    if (senderId === myId) captureEvent("chat_sent", { zone: slug });
    else audio.playChatReceive();
  });

  // A rename rewrites the denormalised name on the sender's past lines; reflect it
  // in the history panel so it doesn't show their old name until a reload.
  conn.db.chatMessage.onUpdate((_ctx, _old, message) => {
    chat.renameSender(message.sender.toHexString(), message.name);
  });

  // Colour isn't denormalised onto chat rows (it's derived from the live player
  // row), so a recolour surfaces as a player-row update — retint the sender's
  // history lines so they match the avatar without a reload.
  conn.db.player.onUpdate((_ctx, _old, p) => {
    if (_old.color !== p.color) chat.recolorSender(p.identity.toHexString(), troggColorFor(p.color, p.identity.toHexString()));
  });
}

/** Pop a speech bubble over a trogg's head, replacing any current one. */
function showBubble(entities: Entities, tracked: Map<string, Tracked>, id: string, text: string) {
  const entry = tracked.get(id);
  if (!entry) return;

  if (entry.bubbleTimer) clearTimeout(entry.bubbleTimer);
  entry.bubble?.destroy({ children: true });

  const bubble = entities.makeBubble(text, entry.sprite ? entities.headTopY() : 0);
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
