# Avatar sprites

`troggs-and-hogs.png` is the avatar **base body** sprite sheet for troggs and
Hogs, with `troggs-and-hogs.atlas.json` describing the frame grid. Everything
here is generated through a two-stage pipeline:

```sh
pnpm sprite-art   # paint logic → shared/sprite_art.ts (indexed pixel maps)
pnpm sprites      # indexed maps → troggs-and-hogs.png + .atlas.json
```

1. [`tools/gen-sprite-art.ts`](../../tools/gen-sprite-art.ts) holds the
   reference-inspired pixel art as readable **paint logic** (the same
   code-authored-pixel approach as the procedural terrain in `terrain.ts`) and
   emits [`shared/sprite_art.ts`](../../shared/sprite_art.ts) as indexed 32×48
   text pixel maps. Art direction is **Pokémon Gold/Silver**: a tight flat
   palette (a base colour, one block shadow, one light), chunky flat shapes, and
   a single dilation pass that traces the same crisp dark outline around every
   silhouette — pixelated, but unmistakably the creature.
2. [`shared/sprites.ts`](../../shared/sprites.ts) defines the rig, frame layout,
   and renderer that blits those maps; the generator in `tools/gen-spritesheet.ts`
   writes the committed PNG/atlas from them.

The paint logic in `tools/gen-sprite-art.ts` is the **source of truth**:
`shared/sprite_art.ts` and the PNG are both generated artifacts. Edit the draw
code and rerun both steps — don't hand-edit the maps or the PNG.

## Layout

The sheet is laid out as **columns = animation frames**, **rows = (kind × style)
× facing** (GDD [Avatars and equipment](../../docs/gdd.md#avatars-and-equipment) —
troggs and Hogs share one rig). A kind's styles come before the next kind's:
trogg `moss` / `stone` / `ridge`, then hog `classic` / `snow` / `ember` /
`buff` / `dino` / `chicken` (`TROGG_STYLES` / `HOG_STYLES` in `shared/sprites.ts`).
Each frame is 32×48 art pixels (32 wide renders as one tile, with the extra
height giving 3/4-view head room), anchored at the feet so a sprite drops onto a tile by its
base. The big hogs (`buff`, `dino`) are authored at this same 32×48 but render at
double size over a 2×2 footprint (`hogSize`); the `chicken` is an easter egg.

| | idle | walk_a | walk_b | run_a | run_b |
| --- | --- | --- | --- | --- | --- |
| trogg `<style>` down / up / left / right | | | | | |
| hog `<style>` down / up / left / right | | | | | |

Look frames up by name in the atlas, e.g. `trogg_moss_down_walk_a`,
`hog_ember_left_idle`. The cosmetic **ghost** (`ghostDraw`) is a one-off indexed
sprite painted at runtime into its own texture, not part of this sheet.

## Scope

This sheet is the avatar **base body only**. Held-item and armour overlays (the
GDD's per-hand main/off layers) reuse this frame grid and anchor when they land
(M2+); the rig reserves their order now. The client paints this art into a
texture at runtime (`src/game/avatars.ts`) and tints troggs by the player's
colour; the committed PNG is the reviewable export, not a runtime dependency.

## World props (tools, stone, boulder)

The same pixel pipeline draws the world props — the held/ground tools (pickaxe,
shovel, sword), the stone resource, and the pushable boulder:

```sh
pnpm item-art   # paint logic → shared/item_art.ts (indexed pixel maps)
```

[`tools/gen-item-art.ts`](../../tools/gen-item-art.ts) shares the GSC paint
helpers in [`tools/pixel_paint.ts`](../../tools/pixel_paint.ts) (also used by the
avatar generator) and emits [`shared/item_art.ts`](../../shared/item_art.ts) as
indexed 24×24 maps. The client paints those into one runtime texture
(`src/game/items.ts`, via `blitArt` in `shared/sprites.ts`) and the world renders
them as sprites — no PNG, no asset file. There is no committed image for props;
the indexed maps are the artifact. Edit the draw code and rerun `pnpm item-art`.
