# Avatar sprites

`troggs-and-hogs.png` is the avatar **base body** sprite sheet for troggs and
Hogs, with `troggs-and-hogs.atlas.json` describing the frame grid. Both are
generated — the pixel art lives in [`shared/sprites.ts`](../../shared/sprites.ts)
as pure paint logic (the same programmer-pixel-art approach as the procedural
terrain in `src/terrain.ts`). Regenerate with:

```sh
pnpm sprites   # or: just sprites
```

The committed PNG is the reviewable artifact; the generator is the source of
truth. Don't hand-edit the PNG — change `shared/sprites.ts` and regenerate.

## Layout

The sheet is laid out as **columns = animation frames**, **rows = kind × facing**
(GDD [Avatars and equipment](../../docs/gdd.md#avatars-and-equipment) — troggs and
Hogs share one rig). Each frame is 16×24 art pixels (16 wide matches the tile;
the extra height is 3/4-view head room), anchored at the feet so a sprite drops
onto a tile by its base.

| | idle | walk_a | walk_b |
| --- | --- | --- | --- |
| trogg down / up / left / right | | | |
| hog down / up / left / right | | | |

`left` is the mirror of `right` (authored once, flipped). Look frames up by name
in the atlas, e.g. `trogg_down_walk_a`, `hog_left_idle`.

## Scope

This is the **base body only**. Held-item and armour overlays (the GDD's per-hand
main/off layers) reuse this frame grid and anchor when they land (M2+); the rig
reserves their order now. The sheet is **not yet wired into rendering** — M0 still
draws the placeholder colour marker (`shared/avatar.ts`, `src/world.ts`). It's
the spritesheet base the GDD "Mascot integration" open thread points at, ready
for when avatar sprites land.
