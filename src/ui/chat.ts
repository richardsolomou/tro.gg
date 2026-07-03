import { CHAT_BUBBLE_MS, CHAT_HISTORY_MAX, CHAT_MAX_CHARS, COLOR_UNSET, timestampMs, troggColorFor, type Zone } from "@trogg/shared";
import type { DbConnection } from "../net/module_bindings";
import type { Player } from "../net/module_bindings/types";
import { cssColor } from "../ui_text.js";
import { hudRoot } from "./hud.js";
import { logError } from "../analytics.js";
import { audio } from "../audio.js";
import { sendChat } from "../net/procedures.js";

/** The world's speech-bubble surface: pops a bubble over a present player's head.
 *  An id with no tracked player is a no-op (the sender left or isn't rendered). */
export interface BubbleHost {
  showBubble(senderId: string, text: string): void;
}

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
 * the log scrolls natively. Speech bubbles over troggs stay in the world renderer (`setupChat`).
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
  input.placeholder = "Press Enter to chat…";
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
 * not the backlog. The `chatAction` procedure emits `chat_sent` without content
 * once the server accepts the line. The bubble half lives in the world renderer
 * (`BubbleHost`); the history half is the HTML `ChatUI`.
 */
export function setupChat(
  conn: DbConnection,
  world: BubbleHost,
  zone: Zone,
  sub: { live: boolean },
  myId: string | undefined,
) {
  const chat = mountChat((text) => {
    audio.playChatSend();
    void sendChat(conn, text).catch((err) => {
      logError("Chat action failed", { surface: "chat", action: "chat", zone: zone.slug, error: err });
    });
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
    world.showBubble(senderId, message.text);
    if (senderId !== myId) audio.playChatReceive();
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
