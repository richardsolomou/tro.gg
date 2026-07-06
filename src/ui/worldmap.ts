import { capitalOf, isBirthZone, REGION_LATTICE_CELL, regionAt, tileGlyph, type RegionVisibility, type Zone } from "@trogg/shared";
import { biomePalette, DAYLIGHT_3D, FOG_MIX } from "../game/palette.js";
import { hudRoot } from "./hud.js";
import { registerKeybind } from "./keybinds.js";

/**
 * The overworld map (`M`): the world downsampled 2×2 and tinted per region
 * palette — sparser than the world but derived from the same generator, so it
 * is always consistent with what's actually there. The world has no edge, so
 * the map paints a viewport centred on your trogg; region names come from the
 * locked `revealed_region` rows (interior and penumbra only — an unreached
 * name never leaks where it is). Shows your own position; never other players.
 */

const CELL = 2; // world tiles per map cell
const PX = 5; // canvas pixels per map cell
/** Viewport span in map cells — a few regions in every direction. */
const VIEW_CELLS = 112;

const css = (colour: number): string => `#${colour.toString(16).padStart(6, "0")}`;
/** Halve each channel — rock reads as clearly darker than the floor it borders. */
const darker = (colour: number): number => (colour >> 1) & 0x7f7f7f;
const HAZE_CSS = css(DAYLIGHT_3D.haze);

interface Viewport {
  /** World tile of the canvas's top-left corner. */
  x0: number;
  y0: number;
  /** Viewport span in world tiles. */
  span: { w: number; h: number };
}

function viewportFor(zone: Zone, centre: { x: number; y: number }): Viewport {
  if (!zone.unbounded) return { x0: 0, y0: 0, span: { w: zone.width, h: zone.height } };
  const spanTiles = VIEW_CELLS * CELL;
  const snap = (v: number) => Math.floor(v / CELL) * CELL;
  return {
    x0: snap(centre.x - spanTiles / 2),
    y0: snap(centre.y - spanTiles / 2),
    span: { w: spanTiles, h: spanTiles },
  };
}

function paintMap(zone: Zone, regionState: (x: number, y: number) => RegionVisibility, regionName: (slug: string) => string | undefined, view: Viewport, canvas: HTMLCanvasElement): void {
  canvas.width = Math.ceil(view.span.w / CELL) * PX;
  canvas.height = Math.ceil(view.span.h / CELL) * PX;
  const ctx = canvas.getContext("2d")!;

  for (let cy = 0; cy * CELL < view.span.h; cy++) {
    for (let cx = 0; cx * CELL < view.span.w; cx++) {
      const x0 = view.x0 + cx * CELL;
      const y0 = view.y0 + cy * CELL;
      const region = zone.unbounded ? regionAt(x0, y0) : undefined;
      const state = regionState(x0, y0);
      const pal = biomePalette(region?.biome ?? zone.biome);
      let open = 0;
      let sampled = 0;
      let water = false;
      let deep = false;
      let glow = false;
      for (let dy = 0; dy < CELL; dy++) {
        for (let dx = 0; dx < CELL; dx++) {
          const glyph = tileGlyph(zone, x0 + dx, y0 + dy);
          if (glyph !== undefined) sampled++;
          if (glyph === "=") deep = true;
          if (glyph === undefined || glyph === "#" || glyph === "=") continue;
          open++;
          if (glyph === "~") water = true;
          if (glyph === "*") glow = true;
        }
      }
      // a bounded zone's out-of-grid cells stay panel-dark
      if (sampled === 0) continue;
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

  if (!zone.unbounded) return;
  // locked region names at their capitals — only for a region that's at least
  // penumbra (those are the only rows the server ever writes), so an unfound
  // name never leaks where it is
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const c0x = Math.floor(view.x0 / REGION_LATTICE_CELL) - 1;
  const c1x = Math.floor((view.x0 + view.span.w) / REGION_LATTICE_CELL) + 1;
  const c0y = Math.floor(view.y0 / REGION_LATTICE_CELL) - 1;
  const c1y = Math.floor((view.y0 + view.span.h) / REGION_LATTICE_CELL) + 1;
  for (let cellY = c0y; cellY <= c1y; cellY++) {
    for (let cellX = c0x; cellX <= c1x; cellX++) {
      const capital = capitalOf(cellX, cellY);
      if (regionState(capital.x, capital.y) === "unreached") continue;
      const name = regionName(capital.slug);
      if (!name) continue;
      const x = ((capital.x - view.x0) / CELL) * PX;
      const y = ((capital.y - view.y0) / CELL) * PX;
      ctx.font = '700 15px "Baloo 2", "Trebuchet MS", system-ui, sans-serif';
      ctx.fillStyle = "rgba(10, 8, 6, 0.65)";
      ctx.fillText(name, x + 1, y + 1);
      ctx.fillStyle = "#e8dcc4";
      ctx.fillText(name, x, y);
    }
  }
}

export interface WorldMapContext {
  zone: Zone;
  /** The local trogg's live tile position, when known. */
  selfPosition(): { x: number; y: number } | undefined;
  /** Interior, penumbra, or unreached (GDD "Generation: only as far as the
   *  light reaches") — the fog-of-war tier a tile is in. */
  regionState(x: number, y: number): RegionVisibility;
  /** A scouted region's locked display name (its `revealed_region` row);
   *  undefined while unreached — the name doesn't exist yet. */
  regionName(slug: string): string | undefined;
}

/** Mount the M-key overworld map overlay. */
export function mountWorldMap({ zone, selfPosition, regionState, regionName }: WorldMapContext): void {
  const panel = document.createElement("div");
  panel.className = "panel worldmap";
  panel.hidden = true;

  const frame = document.createElement("div");
  frame.className = "worldmap-frame";
  const map = document.createElement("canvas");
  map.className = "worldmap-canvas";
  let view = viewportFor(zone, selfPosition() ?? zone.spawn ?? { x: 0, y: 0 });
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
      marker.style.left = `${(((pos.x - view.x0) / CELL) * PX * 100) / map.width}%`;
      marker.style.top = `${(((pos.y - view.y0) / CELL) * PX * 100) / map.height}%`;
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
      view = viewportFor(zone, selfPosition() ?? zone.spawn ?? { x: 0, y: 0 });
      paintMap(zone, regionState, regionName, view, map);
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
