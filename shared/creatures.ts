/**
 * Creature vocabulary shared by the client and the module: kinds, body styles,
 * facings, footprints, and equip slots — where the cast lives.
 */

export type Kind = "trogg";
export type Facing = "down" | "up" | "left" | "right";

/**
 * Cosmetic body variants within a kind (GDD "Avatars and equipment"). A style
 * changes the model's shape and base palette, but not the rig or footprint
 * rules. The first entry of each list is the default.
 */
export const TROGG_STYLES = ["moss", "stone", "ridge"] as const;
export type TroggStyle = (typeof TROGG_STYLES)[number];
export type Style = TroggStyle;

/** The styles a kind offers, default first. */
export function stylesOf(_kind: Kind): readonly string[] {
  return TROGG_STYLES;
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
