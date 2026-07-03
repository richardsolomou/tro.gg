import { REGION_H, REGION_W, regionAt, WORLD_REGIONS, type Zone } from "@trogg/shared";
import { biomePalette } from "../game/palette.js";
import { hudRoot } from "./hud.js";
import { registerKeybind } from "./keybinds.js";

/**
 * The overworld map (`M`): the committed world tilemap downsampled 2×2 and
 * tinted by region palette — sparser than the world but derived from the same
 * data, so it is always consistent with what's actually there. Shows region
 * names and your own position; never other players.
 */

const CELL = 2; // world tiles per map cell
const PX = 5; // canvas pixels per map cell

const css = (colour: number): string => `#${colour.toString(16).padStart(6, "0")}`;
/** Halve each channel — rock reads as clearly darker than the floor it borders. */
const darker = (colour: number): number => (colour >> 1) & 0x7f7f7f;

function paintMap(zone: Zone): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(zone.width / CELL) * PX;
  canvas.height = Math.ceil(zone.height / CELL) * PX;
  const ctx = canvas.getContext("2d")!;

  for (let cy = 0; cy * CELL < zone.height; cy++) {
    for (let cx = 0; cx * CELL < zone.width; cx++) {
      const x0 = cx * CELL;
      const y0 = cy * CELL;
      const region = regionAt(x0, y0);
      if (!region) continue; // the void outside the plus stays panel-dark
      const pal = biomePalette(region.biome);
      let open = 0;
      let water = false;
      let glow = false;
      for (let dy = 0; dy < CELL; dy++) {
        for (let dx = 0; dx < CELL; dx++) {
          const glyph = zone.tiles[y0 + dy]?.[x0 + dx];
          if (glyph === undefined || glyph === "#") continue;
          open++;
          if (glyph === "~") water = true;
          if (glyph === "*") glow = true;
        }
      }
      ctx.fillStyle = open >= CELL ? css(pal.floor.base) : css(darker(pal.wall.face));
      ctx.fillRect(cx * PX, cy * PX, PX, PX);
      if (water) {
        ctx.fillStyle = css(pal.water.base);
        ctx.fillRect(cx * PX + 1, cy * PX + 1, PX - 2, PX - 2);
      } else if (glow) {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = css(pal.glowmoss.mid);
        ctx.fillRect(cx * PX + 2, cy * PX + 2, 1, 1);
        ctx.globalAlpha = 1;
      }
    }
  }

  // region names over their cells
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const region of WORLD_REGIONS) {
    const x = ((region.gx * REGION_W + REGION_W / 2) / CELL) * PX;
    const y = ((region.gy * REGION_H + REGION_H / 2) / CELL) * PX;
    ctx.font = '700 15px "Baloo 2", "Trebuchet MS", system-ui, sans-serif';
    ctx.fillStyle = "rgba(10, 8, 6, 0.65)";
    ctx.fillText(region.name, x + 1, y + 1);
    ctx.fillStyle = "#e8dcc4";
    ctx.fillText(region.name, x, y);
  }
  return canvas;
}

export interface WorldMapContext {
  zone: Zone;
  /** The local trogg's live tile position, when known. */
  selfPosition(): { x: number; y: number } | undefined;
}

/** Mount the M-key overworld map overlay. */
export function mountWorldMap({ zone, selfPosition }: WorldMapContext): void {
  const panel = document.createElement("div");
  panel.className = "panel worldmap";
  panel.hidden = true;

  const frame = document.createElement("div");
  frame.className = "worldmap-frame";
  const map = paintMap(zone);
  map.className = "worldmap-canvas";
  const marker = document.createElement("div");
  marker.className = "worldmap-marker";
  frame.append(map, marker);

  const title = document.createElement("div");
  title.className = "help-section-title";
  title.textContent = "The Caves";
  panel.append(title, frame);
  hudRoot().appendChild(panel);

  let raf = 0;
  const track = () => {
    const pos = selfPosition();
    if (pos) {
      marker.style.left = `${((pos.x / CELL) * PX * 100) / map.width}%`;
      marker.style.top = `${((pos.y / CELL) * PX * 100) / map.height}%`;
      marker.hidden = false;
    } else {
      marker.hidden = true;
    }
    if (!panel.hidden) raf = requestAnimationFrame(track);
  };

  const setOpen = (open: boolean) => {
    if (panel.hidden === !open) return;
    panel.hidden = !open;
    if (open) {
      window.dispatchEvent(new CustomEvent("hud-menu-open", { detail: "worldmap" }));
      track();
    } else {
      cancelAnimationFrame(raf);
    }
  };
  registerKeybind({ id: "worldmap", matches: (event) => event.code === "KeyM", handler: () => setOpen(panel.hidden === true) });
  registerKeybind({ id: "worldmap-close", matches: (event) => event.code === "Escape" && !panel.hidden, handler: () => setOpen(false) });
  panel.addEventListener("click", () => setOpen(false));
  window.addEventListener("hud-menu-open", ((event: Event) => {
    if ((event as CustomEvent<string>).detail !== "worldmap") setOpen(false);
  }) as EventListener);
}
