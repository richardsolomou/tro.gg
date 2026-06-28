# Avatar & item art pipeline

How the creature and item pixel art is authored, generated, and rendered. Read this
before touching any art; it keeps changes cheap and avoids editing generated files.

## Golden rules

- **Never read or hand-edit the generated files** `shared/sprite_art.ts` and
  `shared/item_art.ts` (thousands of lines of indexed pixel maps). Edit the paint code in
  `tools/art/*` and `tools/gen-item-art.ts`, then regenerate.
- **After any art edit, run `pnpm art`** to regenerate everything (sprite maps, item maps,
  and the committed sheet/atlas), or `pnpm art:check` to also run typecheck + tests. CI
  guards against drift, so the generated files and `assets/sprites/*` stay committed in sync.
- **Iterate with `--ascii`, sign off with a PNG.** See Previewing.

## Coordinate system

- Avatar frames are **32×48** (`FRAME_W`/`FRAME_H` in `shared/sprites.ts`). Feet anchor is
  `ANCHOR = {x:16, y:44}` — the point pinned to the tile centre at runtime. +y is down.
- Item frames are **24×24** (`ITEM_ART_W`/`ITEM_ART_H` in `shared/item_art.ts`).
- Art direction is Pokémon Gold/Silver: flat shapes in a tight palette, then one dilation
  pass traces a crisp dark outline around the whole silhouette (`outlinePass`).

## Files

| File | Role |
| --- | --- |
| `shared/rig.ts` | **Skeleton data** (pure geometry, bundled). Joint rest positions per kind×facing, pose offsets (gait + attack), `handJoint`/`jointAt`/`forward`, and per-item `wieldProfile`/`wieldPose`. Read by **both** the generator and the runtime. |
| `tools/art/rig.ts` | **Paint helpers** (tooling). `drawArm` (rig-driven limb), `feet`/`eye`, and the legacy gait maths still used by the baked hog draws. Turns joints into pixels. |
| `tools/art/trogg.ts` | Trogg body + palette; limbs drawn from `shared/rig.ts` joints for every facing/frame (incl. `attack_a`/`attack_b`). |
| `tools/art/hog.ts`, `buff.ts`, `dino.ts`, `chicken.ts`, `ghost.ts` | Other creatures (still baked per-frame; attack frames render as idle). |
| `tools/pixel_paint.ts` | Primitives: `dot`/`rect`/`line`/`disc`/`shaded`, plus `outlinePass`/`quantize`/`fmtArt`. |
| `tools/gen-sprite-art.ts` | Combines creature paint code → `shared/sprite_art.ts` (`pnpm sprite-art`). |
| `tools/gen-item-art.ts` | Item paint code → `shared/item_art.ts` (`pnpm item-art`). |
| `tools/gen-spritesheet.ts` | Packs the committed PNG + atlas under `assets/sprites/` (`pnpm sprites`). |
| `src/game/equipment.ts` | **Held-item placement** (`heldTransform`): the one function that pins an item to the rig's hand joint, oriented/mirrored per facing with the per-item wield pose. Shared by the game and the preview, so every creature wields an item the same way. |
| `src/game/entities.ts` | Runtime: builds textures from the generated maps, drives frames, places held items via `heldTransform`, plays the attack pose on equipment use. |
| `src/preview/main.ts` | **Dev art preview** (`/preview`): a connectionless Phaser page showing each item alone and held by each creature, in all facings, cycling idle/walk/run/attack through `heldTransform`. For designing item art per direction and spotting bad placement. |

## The rig

A creature is a **body** (drawn per creature) plus limbs. For the **trogg** the limbs are
rig-driven: `poseOffset` makes animation *data* — `idle`/`walk_*`/`run_*` are the gait swing;
`attack_a` cocks the main hand, `attack_b` throws it forward (the arm actually extends) — and
the runtime reads the same `handJoint` to pin a held item, so it rides the swinging/extending
arm. The **hog** has its own skeleton too (`HOG_SKELETON`), but its limbs are *baked* into the
frame art, so `poseOffset` only rides the body bob for it — no swing or attack reach — keeping
a held item on the painted paw. The big/costume hogs (buff/dino/chicken) still borrow the hog
skeleton until they get their own.

Frames: `idle`, `walk_a`, `walk_b`, `run_a`, `run_b`, `attack_a`, `attack_b` (`FRAMES`).
Facings: `down`, `up`, `left`, `right` — `left` is the right profile mirrored at render.

## Items

One art source per item. Tools have a **side profile** (`<id>_side`, left/right) and a
purpose-drawn **top-down** view (`<id>_down`/`<id>_up`, up/down) — up/down show the item
from above, not the side shape rotated. The upright `<id>` (side profile stood up) is the
overworld prop and the inventory icon (inventory renders these same pixels, not an SVG).
Per-item `wieldProfile` (`shared/rig.ts`) eases a **hold** pose → **use** pose across the
attack (e.g. pickaxe rests low then strikes; shovel digs down; sword neutral).

## Previewing

```sh
pnpm art:preview --ascii <name> [name...]   # text grid + colour legend — the cheap loop
pnpm art:preview --sheet=trogg_moss         # contact sheet: rows=facings, cols=frames
pnpm art:preview --sheet=item:pickaxe       # one item's views (<id>/_down/_up/_side)
pnpm art:preview --sheet=items              # every ITEM_ART entry
pnpm art:preview --sheet=held:pickaxe       # item *wielded*: rows=facings, cols=frames,
                                            # placed by the game's `heldTransform`
pnpm art:preview --sheet=held:sword+shield  # main-hand + off-hand item, with per-slot z-order
pnpm art:preview <name> [name...]           # a single row of frames
```

Names: avatar frames like `trogg_moss_down_attack_b`, `"ghost"`, or item entries like
`pickaxe`, `sword_down`. PNGs write to `/tmp/sprite-preview.png`; `--sheet`/default print a
layout legend to stdout so the grid is unambiguous. `held:<main>[+<off>][:<creature>]` accepts an
off-hand item and a creature (`held:sword+shield`, `held:pickaxe:trogg_stone`) and is the headless
way to verify a held item rides the rig with the correct per-slot z-order.

For interactive sign-off (animation, scrubbing the attack), run `pnpm dev` and open
`/preview` — the same `heldTransform`, so what you see there is what the game does in-world.
Its `anim` modes include `hit` (the damage flinch), and a `bones` toggle overlays the rig
skeleton on the sprite for checking joint placement.

## Reference art

`docs/art-refs/` holds the source references: `trogg-reference.png` (the hunched cave-ogre
trogg) and `gsc-charmander-reference.jpg` (the GSC art-direction target).
