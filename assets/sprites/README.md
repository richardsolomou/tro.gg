# Avatar sprites

`troggs-and-hogs.png` is the avatar **base body** sprite sheet for troggs and
Hogs, with `troggs-and-hogs.atlas.json` describing the frame grid. Both are
generated — the pixel art lives in [`shared/sprites.ts`](../../shared/sprites.ts)
as pure paint logic (the same programmer-pixel-art approach as the procedural
terrain in `src/game/terrain.ts`). Regenerate with:

```sh
pnpm sprites   # or: just sprites
```

The committed PNG is the reviewable artifact; the generator is the source of
truth. Don't hand-edit the PNG — change `shared/sprites.ts` and regenerate.

## Layout

The sheet is laid out as **columns = animation frames**, **rows = (kind × style)
× facing** (GDD [Avatars and equipment](../../docs/gdd.md#avatars-and-equipment) —
troggs and Hogs share one rig). A kind's styles come before the next kind's:
trogg `moss` / `stone` / `ridge`, then hog `classic` / `snow` / `ember`
(`TROGG_STYLES` / `HOG_STYLES` in `shared/sprites.ts`). Each frame is 16×24 art
pixels (16 wide matches the tile; the extra height is 3/4-view head room),
anchored at the feet so a sprite drops onto a tile by its base.

| | idle | walk_a | walk_b | run_a | run_b |
| --- | --- | --- | --- | --- | --- |
| trogg `<style>` down / up / left / right | | | | | |
| hog `<style>` down / up / left / right | | | | | |

`left` is the mirror of `right` (authored once, flipped). Look frames up by name
in the atlas, e.g. `trogg_moss_down_walk_a`, `hog_ember_left_idle`. The cosmetic
**ghost** (`ghostDraw`) is a one-off sprite painted at runtime into its own
texture, not part of this sheet.

## Scope

This is the **base body only**. Held-item and armour overlays (the GDD's per-hand
main/off layers) reuse this frame grid and anchor when they land (M2+); the rig
reserves their order now. The client paints this art into a texture at runtime
(`src/game/avatars.ts`) and tints troggs by the player's colour; the committed PNG
is the reviewable export, not a runtime dependency.
