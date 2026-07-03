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

export interface HogSkin3D {
  quill: number;
  quillDk: number;
  face: number;
  faceHi: number;
  faceDk: number;
  nose: number;
  eye: number;
  limb: number;
}

export const HOG_SKINS_3D: Record<string, HogSkin3D> = {
  classic: { quill: 0x8a5a2e, quillDk: 0x4a2d14, face: 0xf8d88a, faceHi: 0xfff0bc, faceDk: 0xc6904a, nose: 0x2c1808, eye: 0x100804, limb: 0xa86a30 },
  snow: { quill: 0xc8cad0, quillDk: 0x777b88, face: 0xfff0d8, faceHi: 0xffffff, faceDk: 0xc8b898, nose: 0x504048, eye: 0x181014, limb: 0xb8b0a0 },
  ember: { quill: 0xc85828, quillDk: 0x743014, face: 0xf8d080, faceHi: 0xffecb0, faceDk: 0xc88842, nose: 0x301408, eye: 0x180804, limb: 0xb0602c },
};

export const BUFF_3D = { skin: 0xd89850, skinHi: 0xffd890, skinDk: 0x8c541c, face: 0xf8d88a, quill: 0x8a5a2e, quillDk: 0x4a2d14, nose: 0x2c1808, eye: 0x100804 } as const;

export const DINO_3D = { body: 0x78a030, bodyHi: 0xb8c868, bodyDk: 0x385818, belly: 0xf0d878, tooth: 0xfff4d8, face: 0xf8d88a, nose: 0x2c1808, eye: 0x100804 } as const;

export const CHICK_3D = { body: 0xf8ecd0, bodyHi: 0xffffff, bodyDk: 0xc8b890, comb: 0xe04028, beak: 0xf0a820, beakDk: 0xb87010, tail: 0xc05018, face: 0xf8d88a, eye: 0x100804 } as const;

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
} as const;
