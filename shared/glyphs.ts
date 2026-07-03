/**
 * Tilemap glyphs (GDD "Zones"). Each character in a zone's `tiles` rows is one
 * tile. `WALL_TILE` (`#`) is the only unwalkable glyph — `isWalkable` treats it,
 * and only it, as solid; every other glyph is walkable floor. The non-wall glyphs
 * are cosmetic floor variants (gravel, moss, shallow water, glowmoss) so a zone
 * reads as varied terrain rather than one flat stone fill — they change how a tile
 * is drawn (`src/game/terrain.ts`), never how it collides. Water is a shallow puddle
 * the trogg wades through, so it stays walkable; an impassable pool would be a
 * `#`-class glyph instead. `assertZones` rejects any glyph not listed here.
 * A separate module from the zone registry so the cave generator can use the
 * vocabulary without an import cycle (constants → worldgen → glyphs).
 */
export const WALL_TILE = "#";
export const FLOOR_TILE = ".";
export const GRAVEL_TILE = ",";
export const MOSS_TILE = '"';
export const WATER_TILE = "~";
export const GLOWMOSS_TILE = "*";

/** Every recognised tilemap glyph. A character outside this set is a typo, not a tile. */
export const TILE_GLYPHS: ReadonlySet<string> = new Set([
  WALL_TILE,
  FLOOR_TILE,
  GRAVEL_TILE,
  MOSS_TILE,
  WATER_TILE,
  GLOWMOSS_TILE,
]);
