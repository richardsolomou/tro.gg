/**
 * Creature vocabulary shared by the client and the module: kinds, body styles,
 * facings, footprints, and equip slots. (Named for the sprite sheet it once
 * described; the renderer is 3D now, but this is still where the cast lives.)
 */

export type Kind = "trogg" | "hog";
export type Facing = "down" | "up" | "left" | "right";

/**
 * Cosmetic body variants within a kind (GDD "Avatars and equipment"). A style
 * changes the model's shape and base palette, but not the rig or footprint
 * rules. The first entry of each list is the default.
 */
export const TROGG_STYLES = ["moss", "stone", "ridge"] as const;
/** Every hog style. The common three fill the random roaming crowd; the big two
 *  (buff, dino) are placed showpieces that span a 2x2 footprint and render at
 *  double size; the chicken is an easter egg, summoned, never random. */
export const HOG_STYLES = ["classic", "snow", "ember", "buff", "dino", "chicken"] as const;
/** The small hogs that fill the id-derived random crowd (see `hogStyleFor`). */
export const COMMON_HOG_STYLES = ["classic", "snow", "ember"] as const;
/** Hogs that occupy a 2x2 tile footprint and render at double size (GDD "Hogs"). */
export const BIG_HOG_STYLES = ["buff", "dino"] as const;
export type TroggStyle = (typeof TROGG_STYLES)[number];
export type HogStyle = (typeof HOG_STYLES)[number];
export type Style = TroggStyle | HogStyle;

export const KINDS: readonly Kind[] = ["trogg", "hog"] as const;
export const FACINGS: readonly Facing[] = ["down", "up", "left", "right"] as const;

/** A hog style's tile-footprint span: 2 for the big showpieces, 1 for the rest. */
export function hogSize(style: string): number {
  return (BIG_HOG_STYLES as readonly string[]).includes(style) ? 2 : 1;
}

/** The styles a kind offers, default first. */
export function stylesOf(kind: Kind): readonly string[] {
  return kind === "trogg" ? TROGG_STYLES : HOG_STYLES;
}

/**
 * The facing a movement intent reads as. WASD/path motion sets `(dirX, dirY)`;
 * the dominant axis wins so a diagonal still picks a cardinal. Idle (0, 0) keeps
 * the last facing — a stopped trogg shouldn't snap to a default.
 */
export function facingFromDir(dirX: number, dirY: number, last: Facing): Facing {
  if (dirX === 0 && dirY === 0) return last;
  if (Math.abs(dirX) >= Math.abs(dirY)) return dirX < 0 ? "left" : "right";
  return dirY < 0 ? "up" : "down";
}

/** Unit step in the direction a facing points, in tile space (down = +y). */
export function forward(facing: Facing): { x: number; y: number } {
  switch (facing) {
    case "down":
      return { x: 0, y: 1 };
    case "up":
      return { x: 0, y: -1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
  }
}

/** An equippable attachment slot — where a held item pins to the body. `mainHand`
 *  holds a tool or weapon (the rig's right hand); `offHand` a shield or second
 *  tool (the left). The slot vocabulary is the cross-species contract: every
 *  creature's rig resolves the same slots, so any slot-targeted item can attach
 *  to any creature (GDD "Layered avatars and cross-species equipment"). */
export type EquipSlot = "mainHand" | "offHand";
