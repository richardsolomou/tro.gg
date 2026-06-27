import { CHAT_BUBBLE_MS, CHAT_HISTORY_MAX, CHAT_MAX_CHARS, COLOR_UNSET, timestampMs, troggColorFor, type Zone } from "@trogg/shared";
import type Phaser from "phaser";
import type { DbConnection } from "../net/module_bindings";
import type { Player } from "../net/module_bindings/types";
import { cssColor } from "../ui_text.js";
import { hudRoot } from "./hud.js";
import { currentCommandFlags, handleChatCommand } from "./chat_commands.js";
import { captureEvent, isFeatureEnabled } from "../analytics.js";
import { audio } from "../audio.js";
import type { Entities, Tracked } from "../game/entities.js";

export interface ChatUI {
  /** Append a line to the side-panel history, the name tinted by `color` (0xRRGGBB). */
  addMessage(senderId: string, name: string, text: string, color: number): void;
  /** Rewrite the displayed name on every history line from `senderId` (a rename). */
  renameSender(senderId: string, name: string): void;
  /** Retint the name on every history line from `senderId` (a recolour). */
  recolorSender(senderId: string, color: number): void;
  destroy(): void;
}

interface ChatLine {
  senderId: string;
  name: string;
  text: string;
  color: number;
}

/** Is a text field focused right now? Then Enter belongs to it, not to opening chat. */
function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable === true;
}

/**
 * The chat history and input as an HTML overlay (`hud.css`). A real `<input>` owns
 * typing — so mobile keyboards, paste, IME, and editing are the browser's job — and
 * the log scrolls natively. Speech bubbles over troggs stay in Phaser (`setupChat`).
 */
export function mountChat(send: (text: string) => void): ChatUI {
  const root = document.createElement("div");
  root.className = "panel chat";
  const log = document.createElement("div");
  log.className = "chat-log";
  const input = document.createElement("input");
  input.className = "field";
  input.type = "text";
  input.maxLength = CHAT_MAX_CHARS;
  input.placeholder = "Press Enter to chat...";
  root.append(log, input);
  hudRoot().appendChild(root);

  const lines: ChatLine[] = [];

  const render = () => {
    log.replaceChildren(
      ...lines.map((line) => {
        const row = document.createElement("div");
        row.className = "chat-line";
        const name = document.createElement("span");
        name.className = "chat-name";
        name.style.color = cssColor(line.color);
        name.textContent = `${line.name}: `;
        row.append(name, document.createTextNode(line.text));
        return row;
      }),
    );
    log.scrollTop = log.scrollHeight;
  };

  // Shell-style recall of sent messages. `cursor` indexes `sent`; when it equals
  // sent.length the input holds the live draft (preserved across recall).
  const sent: string[] = [];
  let cursor = 0;
  let draft = "";

  const recall = (delta: number) => {
    if (!sent.length) return;
    if (cursor === sent.length) draft = input.value;
    cursor = Math.max(0, Math.min(sent.length, cursor + delta));
    input.value = cursor === sent.length ? draft : sent[cursor]!;
    input.setSelectionRange(input.value.length, input.value.length);
  };

  const submit = () => {
    const text = input.value.trim();
    input.value = "";
    if (text) {
      if (sent[sent.length - 1] !== text) sent.push(text);
      send(text);
    }
    cursor = sent.length;
    draft = "";
    input.blur();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      // Don't let this Enter bubble to the window "open chat" listener, which would
      // re-focus the input that submit() just blurred.
      e.preventDefault();
      e.stopPropagation();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      input.value = "";
      input.blur();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      recall(-1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      recall(1);
    }
  });

  // Enter from anywhere but a focused field opens chat.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || isTyping()) return;
    e.preventDefault();
    input.focus();
  };
  window.addEventListener("keydown", onKeyDown);

  return {
    addMessage(senderId, name, text, color) {
      lines.push({ senderId, name, text, color });
      while (lines.length > CHAT_HISTORY_MAX) lines.shift();
      render();
    },
    renameSender(senderId, name) {
      for (const line of lines) if (line.senderId === senderId) line.name = name;
      render();
    },
    recolorSender(senderId, color) {
      for (const line of lines) if (line.senderId === senderId) line.color = color;
      render();
    },
    destroy() {
      window.removeEventListener("keydown", onKeyDown);
      root.remove();
    },
  };
}

/**
 * Wires zone chat: every `chat_message` row feeds the side-panel history (the
 * subscription replays recent lines on join), and once live, a new row also pops
 * a bubble over the speaker's head — so bubbles fire only for present players,
 * not the backlog. Own messages emit `chat_sent` — never content (invariant 4 /
 * docs/analytics.md). The bubble half lives in Phaser, so this still takes the
 * scene's `entities`/`tracked`/`stage`; the history half is the HTML `ChatUI`.
 */
export function setupChat(
  conn: DbConnection,
  entities: Entities,
  tracked: Map<string, Tracked>,
  zone: Zone,
  sub: { live: boolean },
  myId: string | undefined,
  stage: Phaser.GameObjects.Container,
) {
  const slug = zone.slug;
  // Slash commands are typed in the chat box but are not chat lines. Spawn/reset
  // fire reducers; ghost stays client-only. Each is independently feature-gated.
  const flags = currentCommandFlags();
  const chat = mountChat((text) => {
    if (handleChatCommand(text, { conn, chat, zone, flags, onGhost: (tile) => entities.hauntGhost(stage, tile) })) return;
    audio.playChatSend();
    conn.reducers.chat({ text });
  });

  const senderColor = (sender: Player["identity"]) =>
    troggColorFor(conn.db.player.identity.find(sender)?.color ?? COLOR_UNSET, sender.toHexString());

  conn.db.chatMessage.onInsert((_ctx, message) => {
    const senderId = message.sender.toHexString();
    chat.addMessage(senderId, message.name, message.text, senderColor(message.sender));
    // Bubbles, the sound, and the analytics event are all for *fresh* lines only: the
    // subscription replays the zone's recent history on join, so suppress everything until
    // the snapshot is applied (`sub.live`), then also skip a line older than a bubble's
    // lifetime (a late-arriving diff right after going live).
    if (!sub.live) return;
    const ageMs = Date.now() - timestampMs(message.createdAt);
    if (ageMs > CHAT_BUBBLE_MS) return;
    showBubble(entities, tracked, senderId, message.text);
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
  entry.bubble?.destroy();

  const bubble = entities.makeBubble(text, entry.sprite ? entities.headTopY() : 0);
  entry.marker.add(bubble);
  entry.bubble = bubble;
  entry.bubbleTimer = setTimeout(() => {
    bubble.destroy();
    if (entry.bubble === bubble) {
      entry.bubble = undefined;
      entry.bubbleTimer = undefined;
    }
  }, CHAT_BUBBLE_MS);
}
