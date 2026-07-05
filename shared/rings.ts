import type { LightSource } from "./light";

export const WORLD_RING_WIDTH = 16;
export const WORLD_GENERATOR_VERSION = 1;
export const WORLD_SEED = 0x70663008;

export function worldRingAt(origin: { x: number; y: number }, x: number, y: number): number {
  return Math.max(0, Math.floor(Math.hypot(x - origin.x, y - origin.y) / WORLD_RING_WIDTH));
}

export function frontlineRing(origin: { x: number; y: number }, sources: Iterable<LightSource>, zoneId: string): number {
  let ring = 0;
  for (const source of sources) {
    if (!source.lit || source.zoneId !== zoneId) continue;
    ring = Math.max(ring, Math.floor((Math.hypot(source.x - origin.x, source.y - origin.y) + source.radius) / WORLD_RING_WIDTH));
  }
  return ring;
}

export function penumbraRing(origin: { x: number; y: number }, sources: Iterable<LightSource>, zoneId: string): number {
  return frontlineRing(origin, sources, zoneId) + 1;
}

export function worldRingSeed(ring: number): number {
  let value = (WORLD_SEED ^ Math.imul(ring + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return value >>> 0;
}
