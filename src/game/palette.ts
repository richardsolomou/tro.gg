/**
 * Creature, item, and terrain palettes — the canonical colour vocabulary for
 * everything the renderer draws. The tones descend from the original pixel-art
 * concept work (`docs/art-refs/`).
 */

export interface TroggSkin3D {
  base: number;
  shade: number;
  light: number;
  muzzle: number;
  eye: number;
  tooth: number;
  /** A heavier bony brow marks `ridge`; the others are smooth-skulled. */
  ridge: boolean;
}

export const TROGG_SKINS_3D: Record<string, TroggSkin3D> = {
  moss: { base: 0x6f8338, shade: 0x38481c, light: 0xb8bd73, muzzle: 0x9ba35a, eye: 0xf83820, tooth: 0xfff4d8, ridge: false },
  stone: { base: 0x74786c, shade: 0x3e4238, light: 0xc6c6a0, muzzle: 0x989a82, eye: 0xf83820, tooth: 0xf6eed6, ridge: false },
  ridge: { base: 0x70673a, shade: 0x342c18, light: 0xc0b06a, muzzle: 0x95884c, eye: 0xf04828, tooth: 0xf0e0bc, ridge: true },
};

/** The grask (GDD "Dark creatures"): a low, feral thing the dark has claimed —
 *  near-black hide, sickly violet undertones, one baleful eye-glow. */
export const GRASK_3D = { base: 0x1c1a20, shade: 0x0c0b0e, light: 0x3a2e42, claw: 0x2a2530, eye: 0x9a3dff } as const;

export const GHOST_3D = { sheet: 0xf6f4ec, sheetDk: 0xd4d4cd, eye: 0x161616, foot: 0x9c6f3f, face: 0xf0dcab, faceDk: 0xcdac72 } as const;

/** Tool and prop materials (tools/gen-item-art.ts). */
export const ITEM_3D = {
  woodLt: 0x9a6330,
  wood: 0x6b3a1d,
  woodDk: 0x3f230e,
  steelLt: 0xe6edf0,
  steel: 0xaeb9bc,
  steelDk: 0x647176,
  gold: 0xf2c94c,
  brass: 0xc49a45,
  rock: 0x74705c,
  rockLt: 0xb4ac78,
  rockDk: 0x45402d,
  leaf: 0x4f8f4a,
  leafDk: 0x36663a,
} as const;

/** Cave terrain tones (src/game/terrain.ts, shared with the landing page). */
export const CAVE_3D = {
  voidBase: 0x0a0806,
  voidSpecks: [0x130d07, 0x1b120a] as const,
  floor: { base: 0x342819, light: 0x3f3020, dark: 0x271d12, pebble: 0x4a3826, crack: 0x1c140c, seam: 0x2a2017 },
  wall: { face: 0x2a2118, top: 0x4a3826, edge: 0x0a0806 },
  gravel: { light: 0x5a4632, mid: 0x4a3826, dark: 0x2f2417 },
  moss: { light: 0x4a6b3a, mid: 0x3b5630, dark: 0x263b21 },
  water: { deep: 0x12303a, base: 0x1b424f, ripple: 0x2f6675, glint: 0x70502e },
  glowmoss: { core: 0x7ff0d8, mid: 0x3fb6a2, halo: 0x224f48 },
} as const;

/** Overworld daylight (GDD "Camera and rendering"): the continent lives under a
 *  sun, not in a cave — sky backdrop, warm sunlight, cool bounce. */
export const DAYLIGHT_3D = {
  sky: 0x8fb8dd,
  haze: 0xa9c9e4,
  sun: 0xfff1d6,
  bounce: 0x8a7050,
} as const;

/**
 * How heavily non-interior ground is tinted toward the haze (GDD "Generation:
 * only as far as the light reaches") — penumbra lightly (scoutable, still
 * legible), unreached heavily (present but unclear). Shared by the 3D terrain
 * and the M map, so the chart always agrees with the world. The 3D view layers
 * drifting fog on top of this baked wash (`src/game/terrain.ts`).
 */
export const FOG_MIX: Record<"interior" | "penumbra" | "unreached", number> = { interior: 0, penumbra: 0.22, unreached: 0.55 };

/** HUD/world accent colours, matching the HTML HUD (`src/ui/hud.css`). */
export const UI_3D = {
  parchment: 0xe8dcc4,
  gold: 0xf2c94c,
  ink: 0x0a0806,
  healthHigh: 0x76c26a,
  healthMid: 0xf2c94c,
  healthLow: 0xc75c52,
  deadBar: 0x4a3826,
  deadName: 0x9b8a6c,
  emberName: 0xd99a5b,
  dormantName: 0x8f877c,
} as const;

// ── biome palettes ─────────────────────────────────────────────────────────────
// Each biome re-tints the cave palette by hue/saturation/lightness shifts (with a
// few explicit accents like glow colour), so ten biomes cost transforms, not ten
// hand-painted tables. Client-only: the shared generator never sees colour.

function hexToHsl(hex: number): { h: number; s: number; l: number } {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): number {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255);
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/** Shift a colour: hue by `dh` (0..1 wraps), saturation and lightness by multipliers. */
function shift(hex: number, dh: number, sMul: number, lMul: number): number {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex((h + dh + 1) % 1, Math.min(1, s * sMul), Math.min(1, l * lMul));
}

type CavePalette = {
  voidBase: number;
  voidSpecks: readonly [number, number];
  floor: { base: number; light: number; dark: number; pebble: number; crack: number; seam: number };
  wall: { face: number; top: number; edge: number };
  gravel: { light: number; mid: number; dark: number };
  moss: { light: number; mid: number; dark: number };
  water: { deep: number; base: number; ripple: number; glint: number };
  glowmoss: { core: number; mid: number; halo: number };
};

function tinted(dh: number, sMul: number, lMul: number, overrides: Partial<CavePalette> = {}): CavePalette {
  const walk = <T>(value: T): T => {
    if (typeof value === "number") return shift(value, dh, sMul, lMul) as T;
    if (Array.isArray(value)) return value.map(walk) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)])) as T;
    return value;
  };
  return { ...(walk(CAVE_3D) as unknown as CavePalette), ...overrides };
}

export const BIOME_3D: Record<string, CavePalette> = {
  cave: CAVE_3D as unknown as CavePalette,
  mossglen: tinted(0.13, 1.15, 1.05),
  emberrift: tinted(-0.045, 1.35, 1.02, { glowmoss: { core: 0xffc17a, mid: 0xe0722e, halo: 0x5a2c12 } }),
  frosthollow: tinted(0.52, 0.75, 1.18, { glowmoss: { core: 0xbfeaff, mid: 0x6fb8dc, halo: 0x2a4f5e } }),
  floodways: tinted(0.42, 1.0, 1.0),
  glowvault: tinted(0.36, 1.1, 0.9, { glowmoss: { core: 0x9ffce2, mid: 0x4fd6ba, halo: 0x2a5f54 } }),
  shadowdeep: tinted(0.62, 0.55, 0.72, { glowmoss: { core: 0xb9a8e8, mid: 0x6f5aa8, halo: 0x2e2548 } }),
  dustworks: tinted(0.035, 0.9, 1.16),
  boneyard: tinted(0.06, 0.42, 1.28),
  starwell: tinted(0.72, 1.1, 0.92, { glowmoss: { core: 0xe8ddff, mid: 0x9a7fe8, halo: 0x3a2e6e } }),
  rustgallery: tinted(-0.02, 1.5, 0.95),
};

/** The palette a zone paints with — its biome's, defaulting to the plain cave. */
export function biomePalette(biome: string): CavePalette {
  return BIOME_3D[biome] ?? (CAVE_3D as unknown as CavePalette);
}
