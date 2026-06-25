import { Application, Container, Graphics, Rectangle, Text } from "pixi.js";
import { CHAT_HISTORY_MAX, CHAT_MAX_CHARS } from "@trogg/shared";
import { blurTextInput, focusTextInput, isTextInputActive } from "./text_input.js";
import { TEXT_RESOLUTION } from "./ui_text.js";

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
  const inputText = new Text({
    text: "Press Enter to chat...",
    style: { fontFamily: FONT, fontSize: 13, fill: MUTED },
    resolution: TEXT_RESOLUTION,
  });

  root.addChild(logBg, logContent, inputBox, inputText);

  const lines: ChatLine[] = [];
  let inputValue = "";
  let focused = false;
  let width = 320;
  let logHeight = 140;
  let scroll = 0;
  let maxScroll = 0;
  let logRect = new Rectangle(0, 0, 0, 0);

  const setInput = (value: string) => {
    inputValue = value.slice(0, CHAT_MAX_CHARS);
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

    inputText.position.set(8, logHeight + 12);
    renderMessages();
    renderInput();
  };

  function renderInput() {
    inputText.text = inputValue || "Press Enter to chat...";
    inputText.style.fill = inputValue ? INK : MUTED;
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
