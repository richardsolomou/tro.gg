# Avatar sprite sheets

Programmer pixel art for troggs and Hogs (GDD pillar 5). These are **generated**
by [`tools/gen-sprites.ts`](../../tools/gen-sprites.ts) — edit that script and run
`pnpm sprites` (or `just sprites`) to regenerate; don't hand-edit the PNGs.

## The rig

Troggs and Hogs share one rig (GDD "Avatars and equipment"), so equipment will
render identically on either. Each sheet is a grid of **32×32** frames:

| | idle | walk-a | walk-b |
| --- | --- | --- | --- |
| **down** | row 0 | | |
| **up** | row 1 | | |
| **left** | row 2 | | |
| **right** | row 3 | | |

- **Anchor** is bottom-centre `(16, 30)` — line the feet up with a tile.
- **right** is the mirror of **left**.
- Walk loops `idle → walk-a → idle → walk-b` for a two-step bounce.

## Files

- `troggs.png` — cave-goblin players: pointed ears, glowing eyes, loincloth.
- `hogs.png` — hedgehog NPCs: cream face, button nose, quilled back.
- `avatars.json` — atlas: per-frame `{x,y,w,h}` rects and named `animations`,
  keyed `<facing>-<frame>` (e.g. `down-walk-a`). PixiJS-style; ready to feed a
  `Spritesheet` / `AnimatedSprite`.

## Status

Not yet wired into the client — placeholder marker rendering still stands (GDD
"Placeholder rendering"; avatar art is an open thread and held-item layers land
at M2). This is the asset, ready to consume.
