# Sprite Improvement Plan

Notes from applying the `agent-sprite-forge` 2D sprite workflow to the current tro.gg
procedural art pipeline.

## Constraints

- Keep the current generated-pixel pipeline. `tools/art/*` and `shared/rig.ts` are the
  source of truth; `shared/sprite_art.ts`, `shared/item_art.ts`, and `assets/sprites/*`
  are regenerated output.
- Treat the external sprite-forge workflow as a QC checklist and reference-generation
  process, not as a replacement for the procedural paint code.
- Preserve the Spine-style contract already in the game: body paint and runtime held-item
  placement must read the same skeleton and pose data from `shared/rig.ts`.
- Keep attack body frames compact. Wide slash arcs, dust, projectiles, and impact bursts
  should be separate runtime FX if added.

## Current Findings

- The shared rig is the strongest part of the current sprites. It already gives troggs
  and Hogs stable named joints, per-frame pose clips, hand anchors, and item layering.
- The stricter Gold/Silver/Crystal pass should prefer a few big readable highlight
  tiles over noisy texture. The reference works because its outline, white highlights,
  and shadow blocks are simple enough to read at overworld scale.
- The trogg silhouette reads well in idle and side motion. Run bob should stay
  grounded against the planted foot baseline.
- Down-facing bare attack frames look smaller because the near arm is removed from the
  body frame and supplied by the held-item arm overlay. That is correct for equipped use,
  but naked attack previews will understate the pose.
- Common Hogs are readable and friendly, but their attack frames depend heavily on held
  equipment for intent. If unarmed Hog attacks become gameplay-visible, they need a
  distinct body-only pose.
- The command-line preview uses raw frame keys such as `hog_classic`; the interactive
  preview uses creature selectors such as `hog:classic`.

## Recommended Passes

1. **Rig QC pass:** add or use skeleton overlays while reviewing contact sheets. Check
   stable foot anchors, same silhouette scale across `idle`/`walk`/`run`, and connected
   shoulder-to-hand limbs.
2. **Trogg locomotion pass:** keep the hunched side run, but keep front/back run grounded.
   Avoid enlarging the arm swing until held-item sheets are checked, because tools and
   shields ride the same joints.
3. **Attack readability pass:** keep body attacks compact and item-driven. If stronger
   feedback is needed, add separate FX layers rather than widening avatar cells.
4. **Hog pose pass:** only add unarmed attack body language if Hogs attack without held
   items. Otherwise keep the current cute idle/walk silhouette and let equipment carry
   action readability.
5. **Reference study pass:** if generated references are useful, create separate
   sprite-forge outputs using `docs/art-refs/trogg-reference.png` and the current contact
   sheets as visual references, then translate accepted ideas back into `tools/art/*`.

## Applied GSC Pass

- Repainted troggs with higher contrast olive/stone ramps, larger brow and belly
  highlights, and fewer mottled speckles.
- Repainted common Hogs and costume Hogs with brighter two-tone fills, sparse white
  highlights, and chunkier interior shadow lines.
- Kept the existing rig, frame layout, arm overlays, and held-item placement contract.
