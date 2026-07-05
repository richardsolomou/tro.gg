import { isBirthZone, regionAt, WORLD_REGIONS, type RegionVisibility, type Zone } from "@trogg/shared";
import { biomePalette, DAYLIGHT_3D } from "../game/palette.js";
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
const HAZE_CSS = css(DAYLIGHT_3D.haze);
/** Matches the same fog mixes `terrain.ts` blends over non-interior ground. */
const FOG_MIX: Record<RegionVisibility, number> = { interior: 0, penumbra: 0.55, unreached: 0.92 };

function paintMap(zone: Zone, regionState: (x: number, y: number) => RegionVisibility, canvas: HTMLCanvasElement): void {
  canvas.width = Math.ceil(zone.width / CELL) * PX;
  canvas.height = Math.ceil(zone.height / CELL) * PX;
  const ctx = canvas.getContext("2d")!;

  for (let cy = 0; cy * CELL < zone.height; cy++) {
    for (let cx = 0; cx * CELL < zone.width; cx++) {
      const x0 = cx * CELL;
      const y0 = cy * CELL;
      const region = regionAt(x0, y0);
      // off the region grid entirely — the void, not a region — stays panel-dark
      if (!region) continue;
      const state = regionState(x0, y0);
      const pal = biomePalette(region.biome);
      let open = 0;
      let water = false;
      let deep = false;
      let glow = false;
      for (let dy = 0; dy < CELL; dy++) {
        for (let dx = 0; dx < CELL; dx++) {
          const glyph = zone.tiles[y0 + dy]?.[x0 + dx];
          if (glyph === "=") deep = true;
          if (glyph === undefined || glyph === "#" || glyph === "=") continue;
          open++;
          if (glyph === "~") water = true;
          if (glyph === "*") glow = true;
        }
      }
      ctx.fillStyle = open >= CELL ? css(pal.floor.base) : css(darker(pal.wall.face));
      ctx.fillRect(cx * PX, cy * PX, PX, PX);
      if (deep) {
        // rivers read as rivers: deep water paints over everything in the cell
        ctx.fillStyle = css(pal.water.deep);
        ctx.fillRect(cx * PX, cy * PX, PX, PX);
      } else if (water) {
        ctx.fillStyle = css(pal.water.base);
        ctx.fillRect(cx * PX + 1, cy * PX + 1, PX - 2, PX - 2);
      } else if (glow) {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = css(pal.glowmoss.mid);
        ctx.fillRect(cx * PX + 2, cy * PX + 2, 1, 1);
        ctx.globalAlpha = 1;
      }
      // Non-interior ground reads as real ground under fog, never a blank
      // panel — penumbra lightly, unreached heavily — the same fog `terrain.ts`
      // blends over its 3D walls and floor.
      const fogMix = FOG_MIX[state];
      if (fogMix > 0) {
        ctx.globalAlpha = fogMix;
        ctx.fillStyle = HAZE_CSS;
        ctx.fillRect(cx * PX, cy * PX, PX, PX);
        ctx.globalAlpha = 1;
      }
    }
  }

  // region names at their capitals — only for a region that's at least
  // penumbra, so an unfound name never leaks where it is
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const region of WORLD_REGIONS) {
    if (regionState(region.x, region.y) === "unreached") continue;
    const x = (region.x / CELL) * PX;
    const y = (region.y / CELL) * PX;
    ctx.font = '700 15px "Baloo 2", "Trebuchet MS", system-ui, sans-serif';
    ctx.fillStyle = "rgba(10, 8, 6, 0.65)";
    ctx.fillText(region.name, x + 1, y + 1);
    ctx.fillStyle = "#e8dcc4";
    ctx.fillText(region.name, x, y);
  }
}

export interface WorldMapContext {
  zone: Zone;
  /** The local trogg's live tile position, when known. */
  selfPosition(): { x: number; y: number } | undefined;
  /** Interior, penumbra, or unreached (GDD "Generation: only as far as the
   *  light reaches") — the fog-of-war tier a tile is in. */
  regionState(x: number, y: number): RegionVisibility;
}

/** Mount the M-key overworld map overlay. */
export function mountWorldMap({ zone, selfPosition, regionState }: WorldMapContext): void {
  const panel = document.createElement("div");
  panel.className = "panel worldmap";
  panel.hidden = true;

  const frame = document.createElement("div");
  frame.className = "worldmap-frame";
  const map = document.createElement("canvas");
  map.className = "worldmap-canvas";
  paintMap(zone, regionState, map);
  const marker = document.createElement("div");
  marker.className = "worldmap-marker";
  frame.append(map, marker);

  const title = document.createElement("div");
  title.className = "help-section-title";
  title.textContent = isBirthZone(zone.slug) ? "The Cave" : "The World";
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
      paintMap(zone, regionState, map);
      window.dispatchEvent(new CustomEvent("hud-menu-open", { detail: "worldmap" }));
      track();
    } else {
      cancelAnimationFrame(raf);
    }
  };
  registerKeybind({ id: "worldmap", matches: (event) => event.code === "KeyM", handler: () => setOpen(panel.hidden === true) });
  // Escape is owned by the game menu (menu.ts); it closes the map through the
  // shared hud-menu-open broadcast, so the map needs no Escape binding of its own.
  panel.addEventListener("click", () => setOpen(false));
  window.addEventListener("hud-menu-open", ((event: Event) => {
    if ((event as CustomEvent<string>).detail !== "worldmap") setOpen(false);
  }) as EventListener);
}
