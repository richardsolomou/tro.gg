# Avatar sprites

`troggs-and-hogs.png` is the avatar **base body** sprite sheet for troggs and
Hogs, with `troggs-and-hogs.atlas.json` describing the frame grid. Both are
generated — the concept-inspired pixel art lives in [`shared/sprite_art.ts`](../../shared/sprite_art.ts)
as indexed 16×24 text pixel maps, while [`shared/sprites.ts`](../../shared/sprites.ts)
defines the rig, frame layout, and renderer. Regenerate with:

```sh
pnpm sprites   # or: just sprites
```

The committed PNG is the reviewable artifact; the indexed source art is the
source of truth. Don't hand-edit the PNG — change `shared/sprite_art.ts` and
regenerate.

## Layout

The sheet is laid out as **columns = animation frames**, **rows = (kind × style)
× facing** (GDD [Avatars and equipment](../../docs/gdd.md#avatars-and-equipment) —
troggs and Hogs share one rig). A kind's styles come before the next kind's:
trogg `moss` / `stone` / `ridge`, then hog `classic` / `snow` / `ember` /
`buff` / `dino` / `chicken` (`TROGG_STYLES` / `HOG_STYLES` in `shared/sprites.ts`).
Each frame is 16×24 art pixels (16 wide matches the tile; the extra height is
3/4-view head room), anchored at the feet so a sprite drops onto a tile by its
base. The big hogs (`buff`, `dino`) are authored at this same 16×24 but render at
double size over a 2×2 footprint (`hogSize`); the `chicken` is an easter egg.

| | idle | walk_a | walk_b | run_a | run_b |
| --- | --- | --- | --- | --- | --- |
| trogg `<style>` down / up / left / right | | | | | |
| hog `<style>` down / up / left / right | | | | | |

Look frames up by name in the atlas, e.g. `trogg_moss_down_walk_a`,
`hog_ember_left_idle`. The cosmetic **ghost** (`ghostDraw`) is a one-off indexed
sprite painted at runtime into its own texture, not part of this sheet.

## Scope

This is the **base body only**. Held-item and armour overlays (the GDD's per-hand
main/off layers) reuse this frame grid and anchor when they land (M2+); the rig
reserves their order now. The client paints this art into a texture at runtime
(`src/game/avatars.ts`) and tints troggs by the player's colour; the committed PNG
is the reviewable export, not a runtime dependency.
