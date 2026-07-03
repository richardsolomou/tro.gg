# Avatar & item art pipeline

How the creature and item pixel art is authored, generated, and rendered. Read this
before touching any art; it keeps changes cheap and avoids editing generated files.

> **Scope since the 3D port:** the game world renders code-built 3D models
> (`src/game3d/`), not these sprites. This pipeline remains the source of the
> inventory item icons (`ITEM_ART`), the committed reference sheets, and the
> `/preview` page — and its palettes are restated in `src/game3d/palette.ts`,
> so palette changes here should be mirrored there.

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
| `tools/art/rig.ts` | **Paint helpers** (tooling). `drawArm` (rig-driven limb), `feet`/`eye`, `bodyBob` (gait body dip). Turns joints into pixels. |
| `tools/art/trogg.ts` | Trogg body + palette; limbs drawn from `shared/rig.ts` joints for every facing/frame (incl. `attack_a`/`attack_b`). Splits `troggBody` + `troggMainArm` so the near arm lifts over a held item. |
| `tools/art/hog.ts`, `buff.ts`, `dino.ts` | Hog bodies + palettes; arms drawn from the rig like the trogg (each splits `*Body` + `*MainArm`). The big buff/dino keep bespoke bodies, rigged limbs. `hog.ts` also paints the common hog's defensive **ball form** (`hogBall` → `HOG_BALL_ART`): a facing-independent curl, so it lives outside the per-facing frame grid. |
| `tools/art/chicken.ts`, `ghost.ts` | Baked per-frame: the chicken's wings flap by a painted offset (no rig arm, attack renders as idle); the ghost is one bespoke drawing. |
| `tools/pixel_paint.ts` | Primitives: `dot`/`rect`/`line`/`disc`/`shaded`, plus `outlinePass`/`quantize`/`fmtArt`. |
| `tools/gen-sprite-art.ts` | Combines creature paint code → `shared/sprite_art.ts` (`pnpm sprite-art`). |
| `tools/gen-item-art.ts` | Item paint code → `shared/item_art.ts` (`pnpm item-art`). |
| `tools/gen-spritesheet.ts` | Packs the committed PNG + atlas under `assets/sprites/` (`pnpm sprites`). |
| `src/game/equipment.ts` | **Held-item placement** (`heldTransform`): the one function that pins an item to the rig's hand joint, oriented/mirrored per facing with the per-item wield pose. Shared by the game and the preview, so every creature wields an item the same way. |
| `src/game/entities.ts` | Runtime: builds textures from the generated maps, drives frames, places held items via `heldTransform`, plays the attack pose on equipment use. |
| `src/preview/main.ts` | **Dev art preview** (`/preview`): a connectionless Phaser page showing each item alone and held by each creature, in all facings, cycling idle/walk/run/attack through `heldTransform`. For designing item art per direction and spotting bad placement. |

## The rig

A creature is a **body** (drawn per creature) plus limbs. The **trogg** and the **hogs**
(common, buff, dino) draw their limbs from the rig: `poseOffset` makes animation *data* —
`idle`/`walk_*`/`run_*` are the gait swing; `attack_a` cocks the main hand, `attack_b` throws it
forward (the arm actually extends, a short reach so it stays connected) — and the runtime reads
the same `handJoint` to pin a held item, so it rides the swinging/extending arm. The common and
big hogs share the one `HOG` skeleton; only the **chicken** stays baked (its wings flap by a
painted offset, no rig arm, attack renders as idle).

Each rigged creature's paint splits into a `*Body` and a `*MainArm` so the generator can lift the
near (main-hand) arm out of the outlined frame and emit it as an **arm overlay** (`ARM_OVERLAY_ART`)
the runtime draws back over a held item — the hand grips the weapon, with no outline seam and no
per-frame re-outline. Facing up the arm sits behind the body, so there's no overlay there.

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
pnpm art:preview --sheet=hog_classic        # common Hog contact sheet
pnpm art:preview --sheet=item:pickaxe       # one item's views (<id>/_down/_up/_side)
pnpm art:preview --sheet=balls              # the common hogs' defensive ball form (ball_<style>)
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

Every control is URL-addressable, so a preview state is a shareable deep link:
`/preview?view=holder&creature=hog:buff&item=sword&off=shield&mode=attack&paused=1&scrub=0.35&bones=1`
(`creature` is `<kind>:<style>` or an index; unknown values fall back to defaults). `pnpm test:e2e`
runs the Playwright harness (`e2e/preview.spec.ts`), which boots these states headless and asserts
the canvas still renders a creature — so an art/rig regression that blanks the preview fails CI
instead of slipping by. It attaches each rendered frame to the report for human sign-off.

## Reference art

`docs/art-refs/` holds the source references: `trogg-reference.png` (the hunched cave-ogre
trogg) and `gsc-charmander-reference.jpg` (the GSC art-direction target).
