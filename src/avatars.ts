import { AnimatedSprite, Assets, Container, Graphics, Rectangle, Texture } from "pixi.js";

/**
 * Layered-sprite avatars (GDD "Avatars and equipment"), behind the
 * `avatar-sprites` flag — replaces the placeholder colour marker with the
 * generated trogg/Hog sprite sheets (`public/sprites/`, see tools/gen-sprites.ts).
 *
 * The rig: a 32×32 frame, anchored bottom-centre, with 4 facings × 3 frames
 * (idle / walk-a / walk-b). Troggs and Hogs share it. Facing is derived from the
 * player's motion intent (dirX/dirY) — the same intent the rest of movement reads
 * (GDD "Movement"), so there's nothing new on the wire. A per-player colour aura
 * under the feet keeps the stable-colour identity the placeholder gave each trogg
 * (GDD "Placeholder rendering"); your own trogg gets a brighter ring.
 */

const FRAME = 32;
const FACINGS = ["down", "up", "left", "right"] as const;
type Facing = (typeof FACINGS)[number];

/** Per-facing walk loop: idle → walk-a → idle → walk-b. Index 0 is the idle pose. */
type SpriteSet = Record<Facing, Texture[]>;

export interface AvatarSheets {
  trogg: SpriteSet;
  hog: SpriteSet;
}

const sheetUrl = (name: string) => `${import.meta.env.BASE_URL}sprites/${name}.png`;

/** Slice a loaded sheet into per-facing walk loops. Columns: 0 idle, 1 walk-a, 2 walk-b. */
function sliceSheet(base: Texture): SpriteSet {
  base.source.scaleMode = "nearest"; // crisp pixels, matching the canvas
  const at = (col: number, row: number) =>
    new Texture({ source: base.source, frame: new Rectangle(col * FRAME, row * FRAME, FRAME, FRAME) });
  const set = {} as SpriteSet;
  FACINGS.forEach((facing, row) => {
    set[facing] = [at(0, row), at(1, row), at(0, row), at(2, row)];
  });
  return set;
}

/** Load both sheets once. Rejects if the assets are missing — caller falls back. */
export async function loadAvatarSheets(): Promise<AvatarSheets> {
  const [trogg, hog] = await Promise.all([
    Assets.load<Texture>(sheetUrl("troggs")),
    Assets.load<Texture>(sheetUrl("hogs")),
  ]);
  return { trogg: sliceSheet(trogg), hog: sliceSheet(hog) };
}

/** Pick a 4-way facing from a motion vector; horizontal wins ties. */
function facingOf(dirX: number, dirY: number, fallback: Facing): Facing {
  if (dirX === 0 && dirY === 0) return fallback;
  if (Math.abs(dirX) >= Math.abs(dirY)) return dirX > 0 ? "right" : "left";
  return dirY > 0 ? "down" : "up";
}

/**
 * A sprite avatar: a colour aura grounding the trogg plus an animated body that
 * faces its travel direction and walks while moving. `setMotion` is cheap and
 * idempotent — call it every frame; it only re-rigs on a facing/state change.
 */
export class Avatar {
  readonly view: Container;
  private readonly sprite: AnimatedSprite;
  private readonly set: SpriteSet;
  private facing: Facing = "down";
  private moving = false;

  constructor(set: SpriteSet, color: number, self: boolean, tile: number) {
    this.set = set;
    this.view = new Container();

    // Colour aura under the feet — keeps each trogg's stable hue (GDD); self
    // gets a brighter outlined ring so you can pick yourself out.
    const aura = new Graphics().ellipse(tile / 2, tile - 2, 8, 3).fill({ color, alpha: self ? 0.85 : 0.5 });
    if (self) aura.ellipse(tile / 2, tile - 2, 9, 4).stroke({ width: 1, color: 0xe8dcc4, alpha: 0.9 });

    this.sprite = new AnimatedSprite(set.down);
    this.sprite.anchor.set(16 / FRAME, 30 / FRAME); // bottom-centre rig anchor
    this.sprite.position.set(tile / 2, tile); // feet at the tile's base
    this.sprite.animationSpeed = 0.15; // ~9fps, reads as a brisk walk
    this.sprite.gotoAndStop(0);

    this.view.addChild(aura, this.sprite);
  }

  setMotion(dirX: number, dirY: number) {
    const moving = dirX !== 0 || dirY !== 0;
    const facing = facingOf(dirX, dirY, this.facing);
    if (facing === this.facing && moving === this.moving) return;
    this.facing = facing;
    this.moving = moving;
    this.sprite.textures = this.set[facing];
    if (moving) this.sprite.play();
    else this.sprite.gotoAndStop(0);
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}
