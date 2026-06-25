import { CanvasTextMetrics, Container, Graphics, Text, type Ticker } from "pixi.js";
import { TEXT_RESOLUTION } from "./ui_text.js";

export interface TextField {
  /** Add this to your HUD container. */
  view: Container;
  /** Position the text origin and set the visible (clipped) width in px. */
  place(x: number, y: number, width: number): void;
  /** Update the rendered content. `caret` is the insertion-point character index. */
  set(state: { value: string; placeholder: string; focused: boolean; caret: number }): void;
  destroy(): void;
}

const BLINK_MS = 530;

/**
 * Renders an editable single-line text field on the Pixi HUD: it clips text to the
 * box, scrolls horizontally to keep the caret in view, and draws a blinking cursor.
 * The hidden DOM input (see text_input.ts) still owns the real keystrokes; this only
 * mirrors its value and caret so the canvas behaves like a normal text box.
 */
export function createTextField(opts: { ticker: Ticker; fontSize: number; ink: number; muted: number }): TextField {
  const { ticker, fontSize, ink, muted } = opts;
  const lineH = Math.ceil(fontSize * 1.4);

  const view = new Container();
  const mask = new Graphics();
  const inner = new Container();
  const label = new Text({
    text: "",
    style: { fontFamily: "monospace", fontSize, fill: muted },
    resolution: TEXT_RESOLUTION,
  });
  const cursor = new Graphics();
  cursor.roundRect(0, 1, 1.5, fontSize + 1, 0.75).fill(ink);
  cursor.visible = false;

  inner.addChild(label, cursor);
  view.addChild(mask, inner);
  inner.mask = mask;

  let boxWidth = 0;
  let scroll = 0;
  let focused = false;
  let value = "";
  let caretIndex = 0;
  let blink = 0;

  const caretX = (count: number): number => {
    if (count <= 0) return 0;
    return CanvasTextMetrics.measureText(value.slice(0, count), label.style).width;
  };

  const onTick = (t: Ticker) => {
    if (!focused) return;
    blink += t.deltaMS;
    const next = blink % (BLINK_MS * 2) < BLINK_MS;
    if (next !== cursor.visible) cursor.visible = next;
  };
  ticker.add(onTick);

  return {
    view,
    place(x, y, width) {
      view.position.set(x, y);
      boxWidth = width;
      mask.clear();
      mask.rect(0, 0, width, lineH).fill(0xffffff);
    },
    set(state) {
      value = state.value;
      focused = state.focused;
      caretIndex = Math.max(0, Math.min(state.value.length, state.caret));

      label.text = state.value || state.placeholder;
      label.style.fill = state.value ? ink : muted;

      const cx = caretX(caretIndex);
      const totalW = caretX(value.length);
      const pad = 2;
      if (totalW <= boxWidth) {
        scroll = 0;
      } else if (cx - scroll > boxWidth - pad) {
        scroll = cx - (boxWidth - pad);
      } else if (cx - scroll < pad) {
        scroll = cx - pad;
      }
      scroll = Math.max(0, Math.min(scroll, Math.max(0, totalW - boxWidth + pad)));

      inner.position.x = -scroll;
      cursor.position.x = cx;

      if (focused) {
        // Re-show the cursor immediately on any edit or caret move, then resume blinking.
        blink = 0;
        cursor.visible = true;
      } else {
        cursor.visible = false;
      }
    },
    destroy() {
      ticker.remove(onTick);
      view.destroy({ children: true });
    },
  };
}
