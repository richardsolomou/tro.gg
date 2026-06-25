import { Application, Container, Graphics, Rectangle, Text } from "pixi.js";
import { isFeatureEnabled } from "./analytics.js";
import { TEXT_RESOLUTION } from "./ui_text.js";

const PAD = 12;
const FONT = "monospace";
const INK = 0xe8dcc4;
const KEY = 0xf2c94c;
const MUTED = 0x9b8a6c;
const DARK = 0x0a0806;
const BORDER = 0x2a2118;
const GAP = 14;
const LINE_H = 20;

/** One control or command line: the key/command and what it does. */
interface Row {
  key: string;
  desc: string;
}

/** A titled block of rows in the help panel (Controls, Commands). */
interface Section {
  title: string;
  rows: Row[];
}

/**
 * The help panel: a top-left "?" toggle that opens a list of controls and chat
 * commands, so a fresh trogg can see what it can do (GDD "Camera and rendering" —
 * HUD surfaces live in the Pixi scene). The listed controls and commands mirror
 * the feature flags actually enabled this session, so the panel never advertises a
 * key or command that's switched off. It's a static reference — no input bridge,
 * no reducers — built once and toggled open/closed.
 */
export function mountHelp(app: Application): void {
  const sections = buildSections();

  const root = new Container();
  root.zIndex = 100;
  app.stage.sortableChildren = true;
  app.stage.addChild(root);

  // The toggle pill, always visible; the body shows only while open.
  const toggle = new Container();
  const toggleBg = new Graphics();
  const toggleText = text("? Help", 13, DARK);
  toggle.addChild(toggleBg, toggleText);
  toggle.eventMode = "static";
  toggle.cursor = "pointer";

  const body = new Container();
  const bodyBg = new Graphics();
  body.addChild(bodyBg);
  body.visible = false;

  root.addChild(toggle, body);

  let open = false;
  let bodyWidth = 0;
  let bodyHeight = 0;

  // Build the body's text rows once: flags don't change mid-session.
  const built = renderSections(sections);
  for (const node of built.nodes) body.addChild(node);
  bodyWidth = built.width;
  bodyHeight = built.height;

  const layoutToggle = () => {
    const w = toggleText.width + 20;
    const h = 28;
    toggleBg.clear();
    toggleBg.roundRect(0, 0, w, h, 4).fill({ color: KEY, alpha: open ? 1 : 0.9 });
    toggleText.position.set(10, (h - toggleText.height) / 2);
    toggle.hitArea = new Rectangle(0, 0, w, h);
    return h;
  };

  const layout = () => {
    root.position.set(PAD, PAD);
    const toggleH = layoutToggle();

    body.position.set(0, toggleH + 6);
    bodyBg.clear();
    bodyBg.roundRect(0, 0, bodyWidth, bodyHeight, 4).fill({ color: DARK, alpha: 0.82 });
    bodyBg.roundRect(0, 0, bodyWidth, bodyHeight, 4).stroke({ width: 1, color: BORDER });
  };

  toggle.on("pointertap", () => {
    open = !open;
    body.visible = open;
    layout();
  });

  app.renderer.on("resize", layout);
  layout();
}

/** The controls and commands to show, filtered to this session's enabled flags. */
function buildSections(): Section[] {
  const canRun = isFeatureEnabled("running");
  const useInteract = isFeatureEnabled("interact");
  const pushEnabled = isFeatureEnabled("boulder-pushing");
  const chatEnabled = isFeatureEnabled("chat-enabled");
  const spawnEnabled = isFeatureEnabled("spawn-command", import.meta.env.DEV);
  const resetBouldersEnabled = isFeatureEnabled("boulder-reset");
  const resetHogsEnabled = isFeatureEnabled("hog-reset");
  const ghostEnabled = isFeatureEnabled("ghost-trogg");

  const controls: Row[] = [
    { key: "WASD / Arrows", desc: "Move" },
    { key: "Click", desc: "Walk to a tile" },
  ];
  if (canRun) controls.push({ key: "Hold Shift", desc: "Run" });
  if (useInteract) controls.push({ key: "E", desc: "Pick up / put down" });
  if (pushEnabled) controls.push({ key: "Walk into a boulder", desc: "Push it" });
  if (chatEnabled) controls.push({ key: "Enter", desc: "Open chat" });

  const sections: Section[] = [{ title: "Controls", rows: controls }];

  // Commands are typed into the chat box, so they only matter when chat is on.
  if (chatEnabled) {
    const commands: Row[] = [];
    if (spawnEnabled) commands.push({ key: "/spawn boulder | hedgehog", desc: "Spawn an object" });
    const resetTargets = [resetBouldersEnabled && "boulders", resetHogsEnabled && "hedgehogs"].filter(Boolean);
    if (resetTargets.length) commands.push({ key: `/reset ${resetTargets.join(" | ")}`, desc: "Reset to the default layout" });
    if (ghostEnabled) commands.push({ key: "/ghost", desc: "Summon a ghost" });
    if (commands.length) sections.push({ title: "Commands", rows: commands });
  }

  return sections;
}

/**
 * Lay out the sections into positioned Text nodes and report the panel's content
 * size. The key column is sized to the widest key so descriptions line up; the
 * panel widens to fit, so nothing wraps or clips.
 */
function renderSections(sections: Section[]): { nodes: Container[]; width: number; height: number } {
  const keys = sections.flatMap((s) => s.rows.map((r) => r.key));
  const keyCol = Math.max(...keys.map((k) => text(k, 13, KEY).width)) + GAP;

  const nodes: Container[] = [];
  let y = PAD;
  let maxRight = 0;

  for (const section of sections) {
    const title = text(section.title, 12, MUTED);
    title.position.set(PAD, y);
    nodes.push(title);
    maxRight = Math.max(maxRight, PAD + title.width);
    y += LINE_H + 2;

    for (const row of section.rows) {
      const key = text(row.key, 13, KEY);
      key.position.set(PAD, y);
      const desc = text(row.desc, 13, INK);
      desc.position.set(PAD + keyCol, y);
      nodes.push(key, desc);
      maxRight = Math.max(maxRight, PAD + keyCol + desc.width);
      y += LINE_H;
    }
    y += 6;
  }

  return { nodes, width: maxRight + PAD, height: y - 6 + PAD };
}

function text(value: string, size: number, fill: number): Text {
  return new Text({ text: value, style: { fontFamily: FONT, fontSize: size, fill }, resolution: TEXT_RESOLUTION });
}
