import * as THREE from "three";
import { UI_3D } from "./palette.js";

/**
 * World-space text/bar overlays: name labels, health bars, speech bubbles, and
 * the respawn countdown, each a camera-facing sprite with a crisp canvas texture.
 * They draw with depth-test off (renderOrder above the world) so a nameplate is
 * never swallowed by a wall.
 */

const FONT = '"Baloo 2", "Trebuchet MS", system-ui, sans-serif';
// Nudge the HUD face into the font cache before the first nameplate paints.
if (typeof document !== "undefined") void document.fonts?.load?.('700 16px "Baloo 2"');
/** Canvas pixels per world unit — the text resolution. */
const CRISP = 160;

function css(colour: number): string {
  return `#${colour.toString(16).padStart(6, "0")}`;
}

export interface Overlay {
  sprite: THREE.Sprite;
  dispose(): void;
}

function spriteFor(canvas: HTMLCanvasElement, worldH: number): Overlay {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 10;
  sprite.scale.set((canvas.width / canvas.height) * worldH, worldH, 1);
  return {
    sprite,
    dispose() {
      texture.dispose();
      material.dispose();
    },
  };
}

/** A one-line nameplate. */
export function makeLabel(text: string, colour: number): Overlay {
  const worldH = 0.28;
  const px = Math.round(worldH * CRISP);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${px * 0.72}px ${FONT}`;
  canvas.width = Math.max(2, Math.ceil(ctx.measureText(text).width) + 8);
  canvas.height = px;
  const c2 = canvas.getContext("2d")!;
  c2.font = `${px * 0.72}px ${FONT}`;
  c2.textAlign = "center";
  c2.textBaseline = "middle";
  // a dark halo keeps the name readable over any floor
  c2.fillStyle = "rgba(10, 8, 6, 0.55)";
  c2.fillRect(0, 0, canvas.width, canvas.height);
  c2.fillStyle = css(colour);
  c2.fillText(text, canvas.width / 2, canvas.height / 2 + 1);
  return spriteFor(canvas, worldH);
}

/** A health bar at `ratio` (0–1), colour-coded green → amber → red. */
export function makeHealthBar(ratio: number, dead: boolean): Overlay {
  const canvas = document.createElement("canvas");
  canvas.width = 72;
  canvas.height = 10;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(10, 8, 6, 0.85)";
  ctx.fillRect(0, 0, 72, 10);
  const fill = dead ? UI_3D.deadBar : ratio > 0.5 ? UI_3D.healthHigh : ratio > 0.25 ? UI_3D.healthMid : UI_3D.healthLow;
  ctx.fillStyle = css(fill);
  ctx.fillRect(1, 1, Math.max(0, Math.round(70 * ratio)), 8);
  return spriteFor(canvas, 0.09);
}

/** A speech bubble: parchment rounded rect, ink text, word-wrapped. */
export function makeBubble(fullText: string): Overlay {
  // the bubble is a glance, not a document — long messages live in the chat log
  const text = fullText.length > 90 ? `${fullText.slice(0, 90)}…` : fullText;
  const worldH = 0.42; // per text line
  const px = Math.round(worldH * CRISP * 0.62);
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = `${px}px ${FONT}`;
  const maxW = px * 14;
  // split into words, breaking any single word too wide for the bubble (pasted
  // walls of characters have no spaces to wrap at)
  const words: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (measure.measureText(word).width <= maxW) {
      words.push(word);
      continue;
    }
    let chunk = "";
    for (const char of word) {
      if (measure.measureText(chunk + char).width > maxW) {
        words.push(chunk);
        chunk = char;
      } else {
        chunk += char;
      }
    }
    if (chunk) words.push(chunk);
  }
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && measure.measureText(candidate).width > maxW) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);

  const pad = px * 0.5;
  const lineH = px * 1.25;
  const textW = Math.max(...lines.map((l) => measure.measureText(l).width), px);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(textW + pad * 2);
  canvas.height = Math.ceil(lines.length * lineH + pad * 2);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = css(UI_3D.parchment);
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, px * 0.4);
  ctx.fill();
  ctx.font = `${px}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = css(UI_3D.ink);
  lines.forEach((l, i) => ctx.fillText(l, canvas.width / 2, pad + i * lineH));
  return spriteFor(canvas, (canvas.height / (lineH + pad * 2)) * worldH);
}

/** A floating damage number: bold ember digits with a dark halo. */
export function makeDamageText(amount: number): Overlay {
  const text = `-${amount}`;
  const worldH = 0.34;
  const px = Math.round(worldH * CRISP);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = `800 ${px * 0.8}px ${FONT}`;
  canvas.width = Math.max(2, Math.ceil(ctx.measureText(text).width) + 10);
  canvas.height = px;
  const c2 = canvas.getContext("2d")!;
  c2.font = `800 ${px * 0.8}px ${FONT}`;
  c2.textAlign = "center";
  c2.textBaseline = "middle";
  c2.lineWidth = px * 0.14;
  c2.strokeStyle = "rgba(10, 8, 6, 0.9)";
  c2.strokeText(text, canvas.width / 2, canvas.height / 2 + 1);
  c2.fillStyle = "#ff8c2e";
  c2.fillText(text, canvas.width / 2, canvas.height / 2 + 1);
  return spriteFor(canvas, worldH);
}

/** Small gold status text (the respawn countdown). */
export function makeStatusText(text: string): Overlay {
  const worldH = 0.24;
  const px = Math.round(worldH * CRISP);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${px * 0.72}px ${FONT}`;
  canvas.width = Math.max(2, Math.ceil(ctx.measureText(text).width) + 6);
  canvas.height = px;
  const c2 = canvas.getContext("2d")!;
  c2.font = `${px * 0.72}px ${FONT}`;
  c2.textAlign = "center";
  c2.textBaseline = "middle";
  c2.fillStyle = css(UI_3D.gold);
  c2.fillText(text, canvas.width / 2, canvas.height / 2 + 1);
  return spriteFor(canvas, worldH);
}
