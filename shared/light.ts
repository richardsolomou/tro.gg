import { tileKey } from "./motion";

export interface LightSource {
  zoneId: string;
  x: number;
  y: number;
  radius: number;
  lit: boolean;
}

export function isTileLit(sources: Iterable<LightSource>, zoneId: string, x: number, y: number): boolean {
  for (const source of sources) {
    if (!source.lit || source.zoneId !== zoneId) continue;
    if (Math.hypot(x + 0.5 - (source.x + 0.5), y + 0.5 - (source.y + 0.5)) <= source.radius) return true;
  }
  return false;
}

export function litTileKeys(sources: Iterable<LightSource>, zoneId: string, width: number, height: number): Set<string> {
  const tiles = new Set<string>();
  for (const source of sources) {
    if (!source.lit || source.zoneId !== zoneId) continue;
    const minX = Math.max(0, Math.floor(source.x - source.radius));
    const maxX = Math.min(width - 1, Math.ceil(source.x + source.radius));
    const minY = Math.max(0, Math.floor(source.y - source.radius));
    const maxY = Math.min(height - 1, Math.ceil(source.y + source.radius));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (Math.hypot(x + 0.5 - (source.x + 0.5), y + 0.5 - (source.y + 0.5)) <= source.radius) {
          tiles.add(tileKey(x, y));
        }
      }
    }
  }
  return tiles;
}
