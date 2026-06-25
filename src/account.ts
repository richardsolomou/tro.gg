import { Application, Container, Graphics, Rectangle, Text } from "pixi.js";
import { COLOR_UNSET, isColorIndex, isValidName, NAME_MAX_CHARS, TROGG_COLORS } from "@trogg/shared";
import type { DbConnection } from "./module_bindings";
import { captureEvent, isFeatureEnabled } from "./analytics.js";
import { signIn, signOut } from "./auth.js";
import { setPendingClaim } from "./identity.js";
import { focusTextInput } from "./text_input.js";
import { TEXT_RESOLUTION } from "./ui_text.js";

const PAD = 12;
const FONT = "monospace";
const INK = 0xe8dcc4;
const DARK = 0x0a0806;
const MUTED = 0x9b8a6c;
const BORDER = 0x2a2118;

/**
 * The account panel (GDD "Identity"): rename your trogg, recolour it, and claim
 * an account when auth is configured. It renders in the Pixi HUD so the game owns
 * visible layout on every viewport. A hidden native input is used only while
 * typing a rename.
 */
export function mountAccount(app: Application, conn: DbConnection, opts: { signedIn: boolean; authAvailable: boolean }): void {
  const myId = conn.identity?.toHexString();
  const myName = () => (conn.identity ? (conn.db.player.identity.find(conn.identity)?.name ?? "") : "");
  const myColor = () => (conn.identity ? (conn.db.player.identity.find(conn.identity)?.color ?? COLOR_UNSET) : COLOR_UNSET);

  const root = new Container();
  root.zIndex = 100;
  app.stage.sortableChildren = true;
  app.stage.addChild(root);

  const bg = new Graphics();
  const who = text("", 13, INK);
  const inputBox = new Graphics();
  const inputLabel = text("", 13, MUTED);
  const status = text("", 12, MUTED);
  const palette = new Container();
  const swatches: Swatch[] = [];
  const action = opts.authAvailable
    ? makeButton(opts.signedIn ? "Sign out" : "Claim account with Discord", async (button) => {
        if (opts.signedIn) {
          await signOut();
          window.location.reload();
          return;
        }

        button.setDisabled(true);
        status.text = "Starting sign-in...";
        const code = crypto.randomUUID();
        try {
          await conn.reducers.startClaim({ code });
        } catch {
          status.text = "Couldn't start sign-in. Try again.";
          button.setDisabled(false);
          return;
        }
        setPendingClaim(code);
        await signIn();
      })
    : null;

  root.addChild(bg, who, inputBox, inputLabel, status, palette);
  if (action) root.addChild(action.root);

  let width = 260;
  let height = 0;
  let inputY = 0;
  let inputValue = "";
  let inputFocused = false;

  const rename = async (raw: string) => {
    const name = raw.trim();
    if (!isValidName(name)) {
      status.text = "3-20 letters, numbers or hyphens.";
      renderInput();
      return;
    }
    await conn.reducers.rename({ name });
    status.text = myName() === name ? "Saved." : "That name's taken.";
    refresh();
  };

  const setInput = (value: string) => {
    inputValue = value.slice(0, NAME_MAX_CHARS);
    renderInput();
  };

  const focusRename = () => {
    inputFocused = true;
    if (!inputValue) inputValue = myName();
    renderInput();
    focusTextInput({
      value: inputValue,
      maxLength: NAME_MAX_CHARS,
      onChange: setInput,
      onSubmit(value) {
        inputFocused = false;
        setInput(value);
        void rename(value);
      },
      onCancel() {
        inputFocused = false;
        inputValue = myName();
        renderInput();
      },
      onBlur() {
        inputFocused = false;
        renderInput();
      },
    });
  };

  if (isFeatureEnabled("trogg-recolor")) {
    TROGG_COLORS.forEach((color, index) => {
      const swatch = makeSwatch(color, () => {
        void conn.reducers.recolor({ color: index });
        captureEvent("trogg_recolored", { color: index });
      });
      swatches.push(swatch);
      palette.addChild(swatch.root);
    });
  }

  const layout = () => {
    const vw = app.screen.width;
    width = Math.min(280, Math.max(220, vw - PAD * 2));
    let y = 8;

    who.position.set(10, y);
    y += 24;

    inputY = y;
    drawInput();
    inputLabel.position.set(18, y + 7);
    y += 36;

    status.position.set(10, y);
    y += 24;

    if (swatches.length > 0) {
      palette.visible = true;
      palette.position.set(10, y);
      swatches.forEach((swatch, i) => swatch.layout((i % 8) * 28, Math.floor(i / 8) * 28));
      y += Math.ceil(swatches.length / 8) * 28 + 4;
    } else {
      palette.visible = false;
    }

    if (action) {
      action.layout(10, y, width - 20, 30);
      y += 38;
    } else {
      y += 4;
    }

    height = y;
    bg.clear();
    bg.roundRect(0, 0, width, height, 4).fill({ color: DARK, alpha: 0.55 });
    root.position.set(vw - PAD - width, PAD);
    renderInput();
  };

  const refresh = () => {
    const name = myName();
    who.text = name ? `You are ${name}` : "Connecting...";
    if (!inputFocused) inputValue = name;
    const color = myColor();
    swatches.forEach((swatch, i) => swatch.setSelected(isColorIndex(color) && i === color));
    renderInput();
  };

  function drawInput() {
    inputBox.clear();
    inputBox.roundRect(10, inputY, width - 20, 30, 4).fill({ color: DARK, alpha: inputFocused ? 0.92 : 0.82 });
    inputBox.roundRect(10, inputY, width - 20, 30, 4).stroke({ width: 1, color: inputFocused ? INK : BORDER });
    inputBox.eventMode = "static";
    inputBox.cursor = "text";
    inputBox.hitArea = new Rectangle(10, inputY, width - 20, 30);
    inputBox.removeAllListeners("pointertap");
    inputBox.on("pointertap", focusRename);
  }

  function renderInput() {
    drawInput();
    inputLabel.text = inputValue || "Rename your trogg...";
    inputLabel.style.fill = inputValue ? INK : MUTED;
  }

  conn.db.player.onInsert((_ctx, p) => {
    if (p.identity.toHexString() === myId) refresh();
  });
  conn.db.player.onUpdate((_ctx, _old, p) => {
    if (p.identity.toHexString() === myId) refresh();
  });

  app.renderer.on("resize", layout);
  layout();
  refresh();
}

type HudButton = {
  root: Container;
  layout(x: number, y: number, w: number, h: number): void;
  setDisabled(disabled: boolean): void;
};

function makeButton(label: string, onClick: (button: HudButton) => void | Promise<void>): HudButton {
  const root = new Container();
  const bg = new Graphics();
  const txt = text(label, 13, DARK);
  let disabled = false;
  let width = 0;
  let height = 0;

  root.addChild(bg, txt);
  root.eventMode = "static";
  root.cursor = "pointer";
  root.on("pointertap", () => {
    if (!disabled) void onClick(button);
  });

  const render = () => {
    bg.clear();
    bg.roundRect(0, 0, width, height, 4).fill({ color: INK, alpha: disabled ? 0.45 : 1 });
    txt.alpha = disabled ? 0.6 : 1;
    txt.position.set(Math.max(8, (width - txt.width) / 2), Math.max(4, (height - txt.height) / 2));
    root.hitArea = new Rectangle(0, 0, width, height);
    root.cursor = disabled ? "default" : "pointer";
  };

  const button: HudButton = {
    root,
    layout(x, y, w, h) {
      root.position.set(x, y);
      width = w;
      height = h;
      render();
    },
    setDisabled(next) {
      disabled = next;
      render();
    },
  };

  return button;
}

type Swatch = {
  root: Container;
  layout(x: number, y: number): void;
  setSelected(selected: boolean): void;
};

function makeSwatch(color: number, onClick: () => void): Swatch {
  const root = new Container();
  const bg = new Graphics();
  let selected = false;
  root.addChild(bg);
  root.eventMode = "static";
  root.cursor = "pointer";
  root.hitArea = new Rectangle(0, 0, 22, 22);
  root.on("pointertap", onClick);

  const render = () => {
    bg.clear();
    bg.roundRect(0, 0, 22, 22, 4).fill(color);
    bg.roundRect(0, 0, 22, 22, 4).stroke({ width: 2, color: selected ? INK : DARK, alpha: selected ? 1 : 0.35 });
  };

  render();
  return {
    root,
    layout(x, y) {
      root.position.set(x, y);
    },
    setSelected(next) {
      selected = next;
      render();
    },
  };
}

function text(value: string, size: number, fill: number): Text {
  return new Text({ text: value, style: { fontFamily: FONT, fontSize: size, fill }, resolution: TEXT_RESOLUTION });
}
