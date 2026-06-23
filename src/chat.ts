import { CHAT_HISTORY_MAX, CHAT_MAX_CHARS } from "@trogg/shared";

export interface ChatUI {
  /** Append a line to the side-panel history, the name tinted by `color` (0xRRGGBB). */
  addMessage(name: string, text: string, color: number): void;
  destroy(): void;
}

/**
 * The chat side panel and input (GDD "Chat" — bubbles live over heads in the
 * PixiJS world; this is the history panel and the typing box). Enter focuses the
 * input when idle and sends when typing; Escape cancels. Names and text are set
 * as DOM text nodes, never HTML — chat is untrusted user content.
 */
export function mountChat(send: (text: string) => void): ChatUI {
  const root = document.createElement("div");
  Object.assign(root.style, {
    position: "fixed",
    left: "12px",
    bottom: "12px",
    width: "320px",
    maxWidth: "calc(100vw - 24px)",
    font: "13px/1.45 monospace",
    color: "#e8dcc4",
    zIndex: "10",
  } satisfies Partial<CSSStyleDeclaration>);

  const log = document.createElement("div");
  Object.assign(log.style, {
    maxHeight: "30vh",
    overflowY: "auto",
    marginBottom: "6px",
    padding: "6px 8px",
    background: "rgba(10, 8, 6, 0.55)",
    borderRadius: "4px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  } satisfies Partial<CSSStyleDeclaration>);

  const input = document.createElement("input");
  input.maxLength = CHAT_MAX_CHARS;
  input.placeholder = "Press Enter to chat…";
  Object.assign(input.style, {
    width: "100%",
    boxSizing: "border-box",
    padding: "6px 8px",
    font: "inherit",
    color: "#e8dcc4",
    background: "rgba(10, 8, 6, 0.8)",
    border: "1px solid #2a2118",
    borderRadius: "4px",
    outline: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  root.append(log, input);
  document.body.appendChild(root);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      if (document.activeElement === input) {
        const text = input.value.trim();
        input.value = "";
        input.blur();
        if (text) send(text);
      } else {
        e.preventDefault();
        input.focus();
      }
    } else if (e.key === "Escape" && document.activeElement === input) {
      input.value = "";
      input.blur();
    }
  };
  window.addEventListener("keydown", onKeyDown);

  return {
    addMessage(name, text, color) {
      const line = document.createElement("div");
      const who = document.createElement("span");
      who.textContent = `${name}: `;
      who.style.color = `#${color.toString(16).padStart(6, "0")}`;
      line.append(who, document.createTextNode(text));
      log.appendChild(line);
      while (log.childElementCount > CHAT_HISTORY_MAX) log.firstElementChild!.remove();
      log.scrollTop = log.scrollHeight;
    },
    destroy() {
      window.removeEventListener("keydown", onKeyDown);
      root.remove();
    },
  };
}
