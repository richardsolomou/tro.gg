# tro.gg — Game Design Document

The buildable spec for tro.gg. If you are an agent working on this codebase: this file is the source of truth for game rules, data, naming, and scope, together with [analytics.md](analytics.md) (events and flags) and [world.md](world.md) (setting, tone, and naming for UI copy). [challenge.md](challenge.md) is human-facing background; you rarely need it. When code and this document disagree, flag the conflict — don't silently pick one.

## How to use this document

- **Glossary names are canonical.** Use them in code, schema, events, and UI. Don't invent synonyms (it's a `node`, not a "resource spawner").
- **Constants marked *(initial)* are starting values.** Keep them centralized in shared constants; make them remotely configurable only when runtime tuning or experiments are useful.
- **The invariants section is non-negotiable.** If a task seems to require breaking one, stop and ask.
- **Roadmap notes are planning context, not gates.** Do not block a task just because it used to belong to a later phase.
- **Custom analytics events and feature flags are registered in [analytics.md](analytics.md)** in the same change that introduces or changes them.

## Glossary

| Term | Meaning |
| ---- | ------- |
| trogg | A player character. Lowercase in prose, `player` in code/schema. |
| zone | One contiguous area of the world. The unit of subscription, rendering, and chat. |
| tile | The grid unit. Positions are integer tile coordinates within a zone. |
| node | A gatherable world object (rock, mushroom). Has a type, a state, and a respawn timer. |
| boulder | A pushable rock. Sits on an unwalkable tile; a trogg pushes it one tile at a time. `boulder` in code/schema. |
| interact | The generic action key (`E`). It picks up ground items and picks up / puts down tile-sized objects; pickup scans adjacent tiles and prioritises the tile the trogg faces, while put-down uses the faced tile first. Future effects (switch, fire) hang off the same key. |
| carry | A trogg holding a tile-sized object (boulder, Hog) on its person — the object leaves its tile until put down. `carrying` in code/schema. |
| action | A timed activity a player starts on a node (mine, forage). One action at a time per player. |
| skill | A progression track (mining, foraging). XP and levels per skill, per player. |
| recipe | A crafting definition: inputs → output, skill requirement. |
| project | A communal construction: the tribe pools resources to build it; completing it unlocks something. |
| Hog | A friendly hedgehog NPC (merchant, townsfolk, protectee). See [world.md](world.md). |
| guest | An anonymous player (self-issued anonymous session). Has a generated name until upgrade. |

## Design pillars

1. One mechanic shipped at a time. The game is always playable.
2. Players are residents, not spectators. Guests join in seconds, no signup wall.
3. Instrumentation is first-class — the dashboards are part of the project, built in the open. Experiments are run transparently: players are told when they're in one.
4. One shared world. No instancing below ~1,000 concurrent in a zone; scaling problems are solved when the graphs demand it, not in advance.
5. Programmer pixel art for now; visual polish and art direction are deferred.

## Core loop

Valheim-grammar progression: gather → craft better tools → better tools reach harder resources → repeat outward into new areas.

1. Land on tro.gg → exist in the world within seconds as a guest (no signup wall).
2. Click a tile (or use WASD) → walk there. Click a node → walk there, then start the action.
3. Action completes → items + XP. Node depletes, respawns later.
4. Craft tools and goods at the Hog town; contribute resources to communal projects that unlock new areas.
5. Chat renders as speech bubbles over heads (and in a side panel).

**Planned onboarding:** new players spawn in the shared starting zone (working name: the cave) and navigate to a checkpoint, which unlocks the hub (`hog-town`). It teaches movement and the world before the full loop opens. The specific framing is deferred (see [world.md](world.md)).

## Systems

### Movement

Two input modes, both supported:

- **Click-to-move:** click a tile → the trogg walks a pathfound route to it. Click a node or obstacle → route to the nearest reachable tile beside it (get as close as possible), then act.
- **WASD / arrow keys:** hold to move in a direction, release to stop. Direct control — the trogg moves until you let go, hit a wall, or reach a zone edge. **4-directional (cardinal only):** up, down, left, right — no diagonals, like classic top-down games (Pokémon, Zelda). Holding two perpendicular keys is resolved last-key-wins (the newest held key steers; releasing it resumes the other), so the intent is always one cardinal axis. The server rejects any diagonal intent rather than coercing it (invariant 3).
- **Grid-locked (tile-to-tile), like Pokémon/Zelda:** a trogg is always either centred on a tile or sliding between two adjacent tile centres — never at rest on a fractional point. Once a step begins it completes to the next tile before the trogg turns or stops, so you can only ever come to rest, or change direction, on a tile centre. A stored origin `(x, y)` is therefore always a whole tile; the server snaps it on settle (invariant 3 — a guard against a misbehaving client). Focus loss is the one exception: the trogg stops where it is (rounded to the nearest tile) rather than finishing the step, since a backgrounded tab can't animate it there.
- **Tap to turn, hold to walk (the Pokémon pivot):** from a standstill, pressing a direction you don't face turns the trogg in place — a quick tap only turns, while holding turns and then begins walking after a short beat (`TURN_TAP_MS` *(initial)*). Pressing the direction you already face walks at once. While already moving, a new direction corners fluidly with no turn-in-place beat. This is why a boulder isn't shoved just by facing it: from a stop you tap to face it, then press in to push (GDD "Pushing"). The in-place facing is synced as `player.faceX`/`player.faceY`, separate from movement intent, so other clients see a standing turn without deriving any movement from it.

Both are **input-driven, not per-frame.** The client writes a movement or facing intent only on input transitions — a click (which sets a path), a key down/up, a direction change, or a standing turn — never on a timer or every frame. For grid-lock, the client holds a turn, a stop, *or a click-to-move re-path* until its predicted avatar reaches the next tile centre, then sends the intent (it detects the centre from its own prediction — a motion transition, not a per-frame sync; the same pattern `push` uses). Holding a mid-step click until the centre is what stops a flurry of clicks from speeding the trogg up: if a re-path landed mid-step the server would settle (round) the fractional position to the *nearest* tile, snapping it forward up to half a tile for free, and resetting `movedAt` — so double-clicking would bank sub-tile distance into a visible, network-wide speed-up. Held to the centre, every re-path starts on a whole tile and the settle snap is a no-op; repeated clicks just overwrite the pending target and resolve to one clean route. A held WASD run is the same kind of motion-transition send: it re-bases its origin to each tile centre it crosses (not a key event, never a per-frame timer — the same once-per-tile cadence `push` uses, invariant 2), so a trogg's position is only ever derived over the last tile rather than from a far-back run-start origin (see Obstacles for why). The server stores each player's motion as an origin `(x, y)`, a direction or a path, and `movedAt`; standing facing is stored separately as `faceX`/`faceY`. Position over time is derived from motion only, and clients render it locally between updates.

- Move speed: 4 tiles/sec *(initial)*, shared by both modes. A click overrides held keys and vice versa.
- **Running:** holding **shift** while moving runs at `RUN_SPEED_TILES_PER_SEC` (7 tiles/sec *(initial)*) instead of walking, controlled by the optional `running` flag (off → shift is ignored, movement stays at walk speed). Run state rides the synced motion intent (`player.running`), so `projectMotion` derives the same faster position on every client — no per-frame sync, no determinism mismatch (invariants 2 & 3). Releasing shift, stopping, or a change of direction re-bases the origin at the current speed (the `move` reducer settles before storing the new intent). Troggs show a faster, hunched run animation (`run_a`/`run_b` in `shared/sprites.ts`); Hogs always walk.
- **Obstacles:** tiles carry a walkability flag; nodes and scenery (trees, rocks, walls) sit on unwalkable tiles. WASD clamps at the first unwalkable tile or the zone edge; click-to-move routes around them. Beyond the static tilemap, **dynamic obstacles** — boulders and Hogs — block a trogg the same way a wall does (see [Pushing](#pushing) and [Hogs](#hogs-roaming)). Walking into a Hog, a trogg **stops flush** against it — its motion settles to a standstill on the tile, rather than holding a "still walking" intent — and resumes the instant the Hog ambles off. This matters because position is *derived* from the intent over elapsed time: a held walking intent jammed behind a moving obstacle banks travel it never made, so when the obstacle clears the derivation would fling the trogg to where the uninterrupted walk would have reached (and the server, re-deriving the same way, would snap it there). Settling to a standstill on contact keeps the intent honest, so there's nothing to release; a click-to-move route that a Hog steps onto likewise stops the trogg flush rather than banking the rest of the path. The mirror hazard is a Hog wandering onto a tile the trogg has *already* crossed: re-deriving from a far-back origin against the now-occupied tile would clamp the trogg flush against it — visibly rewinding it backward. A held WASD run re-bases its origin to each tile centre it crosses (see Movement, above), so an already-passed tile sits behind the origin and can't reach back to rewind it (the WASD counterpart of the forward-only click-to-move projection and the Hogs' tile-by-tile amble); any correction is bounded to the current tile.
- **Pathfinding:** the server runs grid `A*` over the zone's walkable tiles on each click, stores the resulting `path` on the player, and clients animate along that synced path — no client-side recompute, so no determinism mismatch to manage. An obstacle-free zone degenerates to a straight line. The algorithm runs server-side in the room on each click — a small hand-rolled grid `A*` or a battle-tested JS lib (PathFinding.js, easystarjs).
- **No teleport-by-quit.** The stored `(x, y)` is the *origin* of the current move, never the destination. Position is only advanced by elapsed real time × speed along `path`, so clicking far away and quitting skips nothing — on return you're wherever the clock puts you (arrived only if enough time actually passed). A scheduled task may settle `(x, y)` to the path's end at `movedAt + traveltime`, but never before it.
- **Prediction (display only):** because clients sync *intents*, not positions, every client derives the same motion locally and animates other troggs continuously from their last known intent — no per-frame position sync. Clients map the server's `movedAt` onto their local monotonic clock so deployed latency does not make avatars trail their authoritative motion by a round trip. The local player's own accepted input is applied optimistically to display state at the tile centre where it was sent; a matching server row is treated as an acknowledgement and does not restart the animation, while a mismatching row still snaps to server truth (invariant 3).

### Pushing

Boulders are pushable rocks — dynamic obstacles, the same block-pushing grammar as classic top-down games. Walkability is the static tilemap **minus** the tiles boulders occupy, so the very collision that stops a trogg at a wall stops it flush at a boulder. Pushing is independent of — and complemented by — picking a boulder up to carry it (see [Interacting](#interacting-pick-up-and-carry)).

- **A push is walking *into* a boulder, not arriving beside one.** Hold a direction into a boulder you face and it slides ahead of you, one tile at a time, for as long as you keep pushing — like walking. Releasing as you reach it stops the trogg flush against it like a wall (it's an occupied tile), no shove; tap-to-turn (see "Movement") means you face it deliberately first, so you never shove something you only brushed past. The trogg must be **tile-aligned and flush**, and the tile beyond the boulder must be open floor (no wall, no other boulder, no Hog).
- **No tick** (invariant 1) and **server-authoritative** (invariant 3). The client fires `push` off its own prediction — the moment the trogg, moving in a committed direction (not merely facing one), becomes flush against a boulder (a motion transition, once per tile — never per frame, invariant 2). The server re-derives the trogg's position from its stored intent, validates alignment + a clear destination, moves the boulder one tile, and re-bases the trogg's motion to the flush tile. If a Hog stands beyond the boulder the server rejects the shove; since that's transient, the client retries on a throttle while the trogg stays flush, so the push resumes the moment the Hog ambles off rather than latching the trogg in place until it lets go.
- **Cadence falls out of walk speed.** Re-basing leaves the boulder one tile ahead, and the trogg follows into the vacated tile before it's flush again — so the boulder advances at most one tile per tile walked, and a held key gives a steady slide at walk speed, never faster. Spamming `push` can't help: the boulder isn't faced again until the trogg catches up.
- Boulders start from the zone's `boulders` registry entry, seeded into the `boulder` table on first connect, then moved only by `push`. The optional `boulder-pushing` flag can turn this off remotely: off → immovable rocks; on → pushable. Playable either way (invariant 6).
- **Resetting:** the Commands panel can snap the player's current zone back to its registry boulder layout (the `resetBoulders` reducer clears and reseeds the zone). Behind the `boulder-reset` flag — off, the panel hides the boulder reset action. The same panel resets Hogs (GDD "Hogs").

### Interacting (pick up and carry)

`E` is the generic **interact** key. It picks objects up from adjacent tiles and uses the faced tile first when several candidates are in reach, so later interactions (flip a switch, light a fire) can hang off the same key without adding a new control.

- **Pick up / put down is a toggle for tile-sized objects.** Empty-handed, pressing `E` beside a boulder or a Hog **lifts it onto the trogg** — if several are adjacent, the one on the tile the trogg faces wins. It leaves its tile and rides on your person, drawn as a full-size held overlay above the head (the same held-item layering as [Avatars and equipment](#avatars-and-equipment)); pickup changes its position, not its scale. Pressing `E` again **puts it down** on the faced tile (or the nearest free tile), re-materialising it in the world. A trogg carries at most one thing.
- **Throw what you carry.** Pressing `F` while carrying a boulder or Hog throws it in the faced cardinal direction as an instant, tile-based action. It travels up to `THROWN_OBJECT_RANGE` (4 tiles *(initial)*), stops at the first wall or solid object, and damages the first living trogg or Hog it hits by `THROWN_OBJECT_DAMAGE` (40 *(initial)*). The thrown object lands at the farthest clear tile, or near the target it hit.
- **Ground items go into inventory.** Empty-handed, pressing `E` beside a ground item removes that `ground_item` row and adds the item to the trogg's inventory. Starter pickups in `hog-town` are a pickaxe, shovel, and sword. Items are not solid; pickup uses the same adjacent scan and faced-tile priority as tile-sized objects.
- **Anything tile-sized is grabbable.** Boulders and Hogs are the same 1×1 entity to the mechanic; it doesn't care that one is scenery and one is an NPC.
- **Carried things leave the world.** A carried boulder is no longer a collision obstacle; a carried Hog stops wandering — because the entity's row is removed while held and re-inserted on drop. Boulders and Hogs are fungible (no identity, seeded from the `ZONES` registry), but a carried Hog's skin is copied onto the player row and restored on put-down so pickup/drop never changes its look.
- **No tick, server-authoritative** (invariants 1 & 3). `interact` is an input-driven reducer. The client passes its current heading; the server re-derives the trogg's tile and acts only on adjacent entities or ground items, preferring the faced tile when there are multiple candidates, so the client can't reach past its neighbours. Carrying changes nothing per-frame — the held thing simply moves with its carrier, whose position is already derived.
- **Nothing is orphaned.** On disconnect the trogg drops what it holds where it settles; the carried kind is durable on the player row, so even a mid-carry restart loses nothing.
- Behind the optional `interact` flag (off → `E` does nothing). Independent of pushing: pushing shoves a boulder ahead, carrying lifts it (or a Hog) onto your person to relocate, and item pickup moves a ground item into inventory.

### Hogs (roaming)

Ambient **Hog** NPCs (the glossary's friendly hedgehogs) roam the zone on their own — decorative life in the world, controlled by the optional `roaming-hogs` flag (off → no Hogs). This is presence and movement only: no dialogue, trade, or interaction. Merchant, townsfolk, and dialogue roles are separate later work.

- **Same motion model as troggs.** A Hog carries an intent — origin `(x, y)`, a cardinal direction, `movedAt` — and clients derive its position with `projectMotion`, so it's never per-frame synced (invariant 2).
- **Hogs are solid.** A Hog blocks troggs and blocks other Hogs — you can't walk through one, and two Hogs never share a tile. Troggs do **not** collide with each other. A Hog collides against walls, boulders, troggs, and other Hogs; a trogg collides against walls, boulders, and Hogs (the `occupied` predicate of `zoneBounds`, the same seam boulder collision and `push` use). A trogg that walks into a Hog **settles to a standstill** flush against it and resumes when the Hog moves off (see [Movement](#movement) → Obstacles), so a held direction against a roaming Hog never banks a stale step the server would later release as a teleport.
- **Variety and big hogs.** A common Hog's hedgehog skin is derived from its id (`COMMON_HOG_STYLES`: classic, snow, ember), so a zone reads as a varied crowd with no per-Hog field. A few **big Hogs** are placed per zone (the `bigHogs` registry list): a buff flexing hog and a dino-costume hog that occupy a **2×2 footprint** and render at double size. Their `style` is stored on the row (so they never roll from the random crowd), and the footprint span comes from `hogSize(style)` — the whole motion/collision stack (`projectMotion`, the wall clamp, `walkableCardinals`, the wander tick, and every blocker set) is footprint-aware off that one value, defaulting to 1×1. A big Hog blocks its full 2×2 and isn't liftable (the carry overlay is one tile). The chicken-costume hog is a built-but-unplaced **easter egg** (`HOG_STYLES` includes it; it's summoned, never seeded). All styles share the one rig and sheet (`shared/sprites.ts`).
- **Tile-by-tile amble, driven by a scheduled reducer, not a tick.** A Hog only ever commits to one tile at a time. The scheduled `wanderHogs` reducer (SpacetimeDB's deterministic timer — the sanctioned exception in invariant 1, like respawns) fires once per tile-crossing (`HOG_STEP_INTERVAL_MS`, one tile at walk speed) and re-bases every Hog to the tile it reached, so it stops dead in front of whatever's solid instead of gliding through it — and a Hog freed from a block never banks more than a tile of travel. A moving Hog keeps its heading unless that tile is now blocked or a `HOG_TURN_CHANCE` roll turns it (gentle runs, not per-tile jitter); a fresh heading is a random walkable cardinal, or idle with chance `HOG_IDLE_CHANCE` so it pauses. Randomness is the context RNG (seeded from the tick timestamp), so the schedule replays deterministically (invariant 3). (Hogs don't pathfind to a home patch; a Hog ambles cardinally from wherever it is. The `hog` row keeps its `path`/`homeX`/`homeY` columns — unused by the amble — so the schema stays put.)
- **Empty zone, no work.** The timer re-arms only while a player is online; when the last player leaves, the next tick settles every Hog to rest and stops, so an empty world produces no diffs and no work (invariant 1).
- **Server-owned, seeded from the registry.** Hogs have no identity. Their starting tiles come from the zone's `hogs` (common) and `bigHogs` (placed 2×2 showpieces) registry entries (`ZONES` in `shared`), seeded into the `hog` table on first connect (idempotent, like boulders), then moved only by `wanderHogs`. `assertZones` checks each big Hog's 2×2 footprint is clear floor. A Hog's `style` column is usually empty, meaning its skin/size is derived from id; Commands panel spawns store an explicit `HOG_STYLES` value so clicking a skin button creates that exact sprite.
- **Resetting:** the Commands panel can snap the player's current zone Hogs back to their registry population (the `resetHogs` reducer clears and reseeds the zone, the mirror of `resetBoulders`) — the cull for a zone overrun with extra panel-spawned Hogs (though `spawn` refuses past `MAX_HOGS_PER_ZONE` per zone, enforced server-side, so a zone can't be flooded to begin with). A Hog a trogg is carrying rides the player row, not the `hog` table, so it survives the cull and re-materialises on put-down. Behind the `hog-reset` flag — off, the panel hides the Hog reset action.

### Camera and rendering

- 3/4 top-down (RuneScape-2004 / Stardew view), pixel art tiles and sprites.
- Rendered with **Phaser 4** (WebGL canvas) on a Vite + TypeScript client, nearest-neighbour scaled for crisp pixels (`pixelArt`). The client subscribes to the zone's SpacetimeDB tables and draws them; all authority stays server-side (invariant 3).
- Visible in-game HUD surfaces — chat history/input, the top-right account claim control, and the top-left icon toggle bar (Help `?`/`H`, Appearance `P`, Inventory `I`, and the pre-alpha Commands panel `` ` ``) — are HTML/CSS overlays above the Phaser canvas, so the browser owns layout, text input, focus, IME, and resize. They use `pointer-events` so a click on a panel is consumed by the DOM and a click on open space falls through to the canvas (click-to-move). The toggle bar is an accordion: opening one menu closes the others, and `Esc` closes the open menu. World-space labels and speech bubbles over troggs stay in the Phaser scene. Help lists only enabled controls, and the Commands panel exposes only enabled debug tools.

### Audio

- Sound effects are client-side feedback only; they never affect reducers, synced state, or analytics.
- The current audio surface is event-driven: local trogg footsteps fire when movement starts and when the trogg crosses tile centres; boulder push attempts play a scrape and confirmed boulder row movement plays a settle hit; Hog heading changes may play a sparse, low-volume Hog sound after the initial subscription snapshot; chat, commands, command errors, and the ghost haunt play short UI/ghost cues.
- Browsers can block playback before the first user gesture, so rejected play attempts are ignored and retried on the next cue.
- Source files and license notes live under `assets/audio/ATTRIBUTION.md`. Do not wire entire packs wholesale; pick short cues, keep volume conservative, and trim/normalize before promoting a candidate into `src/audio.ts`.

### Avatars and equipment

- A trogg (and a Hog) is a **layered sprite**: a base body plus composable overlay layers, drawn per facing (down/up/left/right) and per animation frame (idle/walk/run/attack). Troggs and Hogs share the rig, so equipment renders the same on either.
- **Creature rig (skeleton + poses).** A creature is a **body** (torso/head, drawn per creature) plus **rig-driven limbs**. The shared skeleton (`shared/rig.ts`) is one source of truth — named joints (`mainShoulder`/`mainHand`/`offShoulder`/`offHand`/hips/feet) per kind per facing, with a `behind` flag — read by **both** the art generator (it draws each limb shoulder/hip→hand/foot, so a frame's pose *is* the drawing) and the runtime (it anchors a held item to the same `handJoint`). Animation is **pose data, not code**: `poseOffset(kind, facing, frame, joint)` gives the per-frame delta, so gait (`walk_*`/`run_*`) and attack (`attack_a` wind-up, `attack_b` strike) are clips a creature carries, and other creatures can move differently without bespoke per-frame maths. The gait scissors the feet on the side facings (the lifted foot swings ahead, the planted one trails back) and the upper body carries `bodyLean` — the run hunch and the attack's weight shift — shared by the rig's shoulders/hands and each creature's torso paint, so the whole upper body leans as one piece and a held item rides the leaning arm. The runtime plays the stride as the GSC **four-phase cycle** — step, passing pose (idle), other step, passing pose (`avatarFrame`, `shared/sprites.ts`) — walking and running on the same cycle at different step lengths. `left` mirrors `right` (the side art is the right profile, flipped). Equipment use plays the attack pose, so the creature's **arm actually extends** (the strike throws `mainHand` forward, a short reach so the limb stays connected); the held item rides that joint, reaching with it. The near (main-hand) arm is also lifted out of each front-facing frame and **redrawn over a held item**, so the hand grips the weapon rather than the weapon covering the arm. The use reads as a swing, not a poke: a brief wind-up then the strike held through a slower recovery (`attackEase`/`STRIKE_PEAK`, `src/game/equipment.ts`). Taking damage plays a **hit flinch** — a short recoil opposite the facing plus a white flash (`flinchPose`), triggered when a creature's health drops; troggs and Hogs both flinch.
- **Held items** (pickaxe, shovel, sword, shield) render as per-hand layers — a **main hand** and an **off hand**, so combinations like sword + shield work. Each hand has its own anchor (the rig's `handJoint`) and z-order per direction/frame (the off-hand arm and its item sit behind the body when facing up, in front when facing down). A new holdable is a new item sprite, not a new character. Each holdable carries **directional in-hand frames** (`<id>_down` / `_up` / `_side`, `left` mirroring `side`): authored once as a canonical combat-ready pose — gripped at centre, business end leading right — and emitted as clean 90° rotations, so a wielded item points the way the trogg faces, hilt in the fist. Each item is oriented one of two ways on the side facings (`shared/rig.ts`). A tool with a **grip** rigidly follows the forearm (`armAngle` + grip), so it reads as a rigid extension of the arm and **swings with it as one piece** — the wind-up and the downward chop come from the arm's own pose, in sync with the drawn arm, not a separate item curve; so a pickaxe and shovel arc down into the target rather than poking forward. The sword instead keeps a **fixed** forward orientation and is carried by the arm's thrust. A small per-item *held*→*use* pose (offset/scale) still eases across the attack on top. A single shared placement function (`heldTransform`, `src/game/equipment.ts`) pins the item to the rig hand joint for the current pose — so it swings through the walk/run cycle and rides the extending arm on attack — and draws it behind the body when facing away. Both the live game and the dev preview place items through it, so every creature wields an item the same way. **Two views per item, one art source:** a **side profile** (`<id>_side`, mirrored for left) for the left/right facings, and a purpose-drawn **top-down** view (`<id>_down`/`<id>_up`) for up/down — so facing up/down shows the item from above, not the side shape rotated (a sword's blade foreshortens toward the camera, a pickaxe reads as the overhead head-and-handle, a shovel as the flat spade). The upright `<id>` (the side profile stood up) is the overworld prop and the inventory icon — the inventory renders the same `ITEM_ART` pixels, not a separate vector icon — so every surface draws from the one item art.
- **Armor (later)** layers the same way over body slots (head, torso). The rig reserves the layer order now; armor sprites are added with the mechanic.
- What's equipped rides the zone's player sync, so others see what you're holding. Pressing `F` uses what the trogg is currently holding or wielding without stopping movement: a carried boulder or Hog is thrown, a pickaxe mines a faced boulder into Stone, a sword attacks a faced adjacent trogg, and a shovel currently shows its synced use animation only. Held-item rendering is built extensibly from the first shipped tools. The tools, the stone resource, and the boulder are pixel-art props in the same Pokémon Gold/Silver style as the avatars — painted by paint logic in `tools/gen-item-art.ts` (sharing `tools/pixel_paint.ts` with the avatar generator), emitted to `shared/item_art.ts`, and rendered to a runtime texture by `src/game/items.ts`.
- **Sprite avatars (`avatar-sprites`):** a trogg renders as the layered avatar sprite — reference-inspired pixel art (Pokémon Gold/Silver art direction — flat palette, clean dark outlines) painted by paint logic in `tools/gen-sprite-art.ts` (the source of truth), emitted as indexed 32×48 maps in `shared/sprite_art.ts`, and rendered through `shared/sprites.ts` (per body style × 4 facings × idle/walk/run/attack, troggs and Hogs sharing one rig), feet anchored at the centre of the tile (not its bottom edge, so a grid-locked trogg stands in the middle of its tile). The per-trogg colour rides as a sprite **tint**, so the same trogg is the same colour for everyone, every session; your own trogg gets a ground ring so you can pick it out. The committed sprite sheet asset (`assets/sprites/`) is the reviewable export; the client paints the same art into a texture at runtime. The authoring/generation/preview workflow — the rig, the helper vocabulary, the `pnpm art` / `pnpm art:preview` commands, the dev-only `/preview` page for inspecting items held by each creature in every direction, and the rule never to hand-edit the generated maps — is documented in [`tools/art/README.md`](../tools/art/README.md).
- **Hog ball form:** each common Hog style (`COMMON_HOG_STYLES`) has a defensive **ball** sprite — the hog curled spiky-side-out, painted by `hogBall` in `tools/art/hog.ts` and emitted as `HOG_BALL_ART` in `shared/sprite_art.ts`. It's one facing-independent pose (a ball reads the same from any side), so it lives outside the per-facing frame grid and isn't packed into the committed avatar sheet; the client paints it into its own runtime texture (`AVATAR_BALL_TEX`, `src/game/avatars.ts`). **A picked-up Hog renders as its ball** — the carry overlay swaps the upright idle frame for the ball (`makeCarried`, `src/game/entities.ts`), so lifting a Hog curls it. Styles without a ball (the chicken easter egg) fall back to the idle frame; big Hogs (buff/dino) aren't liftable, so they never need one. The further curl-when-attacked-then-roll-away behaviour is later work. Preview the art with `pnpm art:preview --sheet=balls`, or the in-engine swap on the `/preview` page in **ball** mode (`mode=ball`).
- **Placeholder marker (kill-switch fallback):** with `avatar-sprites` off, a trogg draws as a solid tile-filling marker in its colour (own trogg outlined) — the original placeholder, kept as the flag's fallback.
- **Two appearance axes — style and colour.** A trogg's look is a **body style** (the sprite shape) plus a **colour tint** over it; the two are independent, so any style can wear any colour. Each is the value the trogg chose, or — until it chooses — a stable default derived from its durable id (a deterministic projection, like a level from XP; `STYLE_UNSET` / `COLOR_UNSET` = -1 are the unchosen sentinels). Both ride the zone player sync, so the sprite (and the trogg's chat-name colour) update everywhere they're shown.
- **Trogg style (`trogg-restyle`):** styles come from a fixed list (`TROGG_STYLES` in `shared`: `moss`, `stone`, `ridge`) that vary the silhouette features (ear nubs / earless crag / horns) and base palette — same rig, different head and tone. A trogg picks one via the `restyle` reducer, which stores its chosen index on the `player` row (validated server-side, invariant 3). The optional flag controls whether the style buttons show in the Appearance panel.
- **Trogg colour (`trogg-recolor`):** the tint comes from a fixed palette (`TROGG_COLORS` in `shared`), chosen via the `recolor` reducer (the mirror of `restyle` on the colour axis). The optional flag controls whether the palette swatches show in the Appearance panel.
- **Hog variation.** Ambient seeded Hogs usually leave `hog.style` empty, so each skin is derived from entity id (`COMMON_HOG_STYLES`: `classic`, `snow`, `ember`), giving a zone a varied, stable crowd. A concrete `hog.style` pins an exact sprite: the `BIG_HOG_STYLES` showpieces (`buff`, `dino`) render at double size over a 2×2 footprint (`hogSize`), and `chicken` is a built-but-unseeded easter egg — the full set is `HOG_STYLES` (`classic`, `snow`, `ember`, `buff`, `dino`, `chicken`). Commands panel spawns store the selected style so the sprite is exact. Once a Hog is picked up, its effective style is stored as `player.carryingStyle` and written back to `hog.style` on put-down, so the replacement row keeps the same look despite getting a new id. Hogs are never tinted.
- **Ghost (`ghost-trogg`):** the cosmetic easter egg is its own bespoke sprite (`ghostDraw` — a hog draped in a pale sheet, two eye holes, scalloped hem), painted into a standalone texture and never tinted. Summoning it inserts a zone-scoped `ghost_haunt` row; live clients in that zone render the fresh insert once as a slow materialise, gentle drift, linger, and fade-out, while late joiners ignore the replayed snapshot.
- **Appearance panel.** Rename, recolour, and restyle are one top-left HUD icon toggle (`P`, beside Help/Inventory/Commands) — everything about how your trogg *looks* in one place. The separate top-right account panel is only the claim/sign-out control (`auth-enabled`).

#### Layered avatars and cross-species equipment (design)

The target the rig is being built toward: a creature is not one drawing but a **stack of layers** — base body, eyes, hair, outfit, armour pieces (breastplate, helmet, …), and held items — composited per facing and frame. Cosmetics and equipment are layers you add, so players look different and gear is visibly worn. This is the paper-doll / layered-equipment pattern; we build a thin code-defined version on the rig rather than adopting a skeletal-animation engine (Spine/DragonBones solve exactly this with slots + skins, but they are editor- and mesh-driven and would replace the procedural pixel pipeline — wrong fit for code-generated 4-direction pixel art).

- **The rig is a cross-species slot contract.** It generalises from today's single `handJoint` to a fixed vocabulary of named **slots** — `head`, `eyes`, `face`, `chest`, `mainHand`, `offHand`, `back`, `feet` — each a positioned anchor (a point, plus an optional fit region/size) defined **per species × facing × frame**. The slot *names and semantics are shared across species*, so any layer that targets a slot can be placed on any creature that implements the rig. A new monster race = implement the slots + paint its body; it then supports every existing item.
- **Item identity is species-agnostic; item *rendering* resolves per (item, species).** An item (a breastplate) is one registry entry — id, slot, stats, drop, equippable — independent of who wears it. How it *looks worn* is resolved per wearer: a **bespoke per-species art variant** when authored, else a **procedural slot-fit fallback** drawn against that species' slot anchors/region, so a new species wears every existing item on day one (polished with bespoke art later). "Fits differently on each species" is exactly this — each body's `chest` slot has its own size/shape, and the breastplate scales to it or has its own drawing. Stats travel with the item; fit travels with the wearer.
- **Per-facing layer order replaces the binary `behind` flag.** Each species defines, per facing, an ordered layer list (e.g. back-hair → far arm → body → torso armour → near arm → held item → helmet/face → front hair). Occlusion — a weapon hidden in the fist, a breastplate over the torso, hair behind the head facing up — becomes z-order, not per-direction hand-painted art. This is the principled version of the handle-hidden-under-the-arm problem.
- **Runtime composition, synced loadouts.** The look of a creature is its equipped + cosmetic set. The client composites that loadout's layers into one cached avatar texture per (species, loadout) — the combination space is too large to pre-bake, and the client already paints avatar textures at load. Each player syncs its slot choices (extending today's `equippedMainHand` and the appearance style/colour axes); everyone sees the exact loadout. Per-layer tint/palette is how colour variety (hair, armour) rides without separate art per colour.
- **Composite-then-outline rendering (the keystone).** This is *how* layering keeps the Gold/Silver look while staying arbitrarily flexible. Each layer (body, armour, hair, eyes, …) is authored as an **interior fill with no outline of its own**; the client stacks the equipped layers in z-order into one buffer and runs the **single dilation outline pass over the assembled silhouette**, then caches the result per (loadout, facing, frame). So there is *one* unified dark outline around the whole assembled creature — body + breastplate + helmet + hair — with **no internal seams**; internal definition comes from per-layer shading (exactly how the trogg's arm reads against its torso today). This is what makes the system flexible without the per-layer-outline seams that a naive split produces, and it generalises to any species (each composites its own stack). The migration is: move the outline/composite primitives into shared (runtime-usable), have the generator emit **un-outlined fill** layer maps, composite + outline at load, cache per loadout; legacy single-creature frames fall out as the degenerate one-layer case. **Held items are the deliberate exception** — they stay *separately-outlined overlays* with binary in-front/behind z-order per facing (their own per-direction art), because folding a continuously-moving item into the unified outline would force a re-composite + re-outline every animation frame. Partial occlusion of a held item by the wielder's own hand is solved with one targeted split: the near (main-hand) arm is lifted out of the already-outlined frame as a separate overlay and redrawn over the item (no seam, no per-frame re-outline), while the rest of the body stays one silhouette. This is the first real layer split, and the seam the worn-armour layers will follow.
- **Limb separability gates layered armour.** Interleaving armour and weapons with the body (armour between torso and the near arm; a weapon behind the fist) needs the body's limbs as their own layers. The **trogg and every hog but the chicken** now draw their limbs from the shared rig (the chicken's flapping wings stay baked), and the near-arm-over-item split proves out the lifting technique. So every rig-driven creature is ready for layered gear; a new race implements the rig and gets it for free.
- **Cross-species lifecycle.** A monster dies → drops the item as a species-agnostic `ground_item` → any creature picks it up and equips it → it renders with that wearer's own fit. The drop, the inventory row, and the stats are the item's; the silhouette is the wearer's.

Current state this generalises from: the rig resolves **both hands** as equip slots — `slotAnchor(kind, "mainHand" | "offHand", …)`, with per-slot z-order (the near/main hand in front except facing up, the far/off hand behind the body except facing down) — and `heldTransform` places any slot, so a sword + shield compose correctly. **Both hands are now equippable and synced gameplay-side**: `equippedMainHand` and `equippedOffHand` (each with its inventory-row pointer) route by the item's slot, a **shield** equips to the off hand from the inventory panel, and every client renders both overlays on the rig (the shield is cosmetic for now — it has no block effect yet). What's *not* wired yet is the multi-layer order *table* for worn armour, which lands with its consumers. The **trogg** and the **hogs** (all but the chicken) are rig-driven, and the near arm already lifts over a held item as the first real layer split. Layers are then added cheapest-first (eyes/hair before armour).

Open questions to resolve before building: procedural slot-fit vs per-species art as the *default* (and the quality bar for stretched pixels); whether a slot carries a size/region or just a point; pre-composited textures vs live-stacked sprites at high player counts; per-layer palette/tint vs separate art for colour variety; and how cosmetic-only layers (hair, eyes) fold into the existing appearance/`restyle` model.

### Zones

- A zone has a slug, display name, integer width/height in tiles, and a tilemap: per-tile walkability plus scenery. Nodes and obstacles sit on unwalkable tiles.
- **Tile glyphs.** Each character of a zone's `tiles` rows is a tile glyph (`TILE_GLYPHS` in `shared`). `WALL_TILE` (`#`) is the only unwalkable glyph — `isWalkable` keys solely off `#`, so collision and pathfinding ignore the rest. The other glyphs are **cosmetic floor variants** that dress the stone so a zone reads as varied terrain instead of one flat fill: `.` plain floor, `,` gravel scree, `"` moss, `~` shallow water (walkable — a puddle the trogg wades through; an impassable pool would be a `#`-class glyph), `*` glowmoss. The client paints a tile-sized overlay per variant (`src/game/terrain.ts`); they change rendering only, never movement. `assertZones` rejects any glyph not in `TILE_GLYPHS`. Add a new variant by registering its glyph and an overlay painter together.
- **Zone definitions are a static code registry** (`ZONES` in `shared`, keyed by slug) — static design data like the item and node registries, not the durable `zones` table the data model lists. The table is deferred until tilemaps need editable storage; until then a zone is a registry entry. A client subscribes to one zone's rows by slug (`WHERE zone_id = …`); zone dimensions and the tilemap (`tiles`, walkability read through `isWalkable`) come from the shared `ZONES` registry (imported by both the client and the module), so the grid is shared design data, not a per-session value. The client renders walls and floor variants from the same tilemap it collides against, so what's drawn is what blocks you.
- **Spawn and the hub gate:** new players spawn in a shared **starting zone** (working name: the cave) and must reach a checkpoint to unlock the hub, `hog-town`. The hub isn't available until the checkpoint is crossed — a per-player progression gate, not an instance; the starting zone is shared like any other.
- The current world ships a single shared zone *(working slug `hog-town`, 24×16 (initial))*; additional zones, starting areas, and gates can be added when they help the current gameplay.
- Clients subscribe to players/nodes/chat **in their current zone only**. Within a zone, sync is deliberately naive (whole-zone queries) — see invariant 10.
- New zones ship incrementally; transitions are walk-to-edge or interact-with-passage. How later areas gate (checkpoints, light, communal projects) is an open thread.

### Chat

- Zone-scoped. Max 200 chars *(initial)*. Bubble displays 5s *(initial)*; side panel keeps recent history.
- Chat history and the typing field are HTML overlays (a real `<input>`); speech bubbles over troggs render in the Phaser scene. Chat content is added as a DOM text node, never as HTML markup, so a message can't inject markup.
- Server-side rate limit: 1 message/sec per player *(initial)*.
- Message content is **never** sent to analytics.
- **Pre-alpha Commands panel:** debug tools live in the top-left Commands panel, not chat slash commands. The spawn grid uses actual registered sprites: one boulder button, one button per `HOG_STYLES` skin/size, and one button per `SPAWNABLE_ITEM_IDS` equipment item (`pickaxe`, `shovel`, `sword`, `shield`). `stone` remains a valid inventory/resource item, but it is gathered through mining and is not exposed or accepted by debug spawning. Each click requests exactly one spawn; if someone wants ten Hogs, they press a Hog button ten times. The `spawn` reducer places the thing on a nearby free tile around the caller, starting with the tile they face, and clamps inserts to `MAX_BOULDERS_PER_ZONE`, `MAX_HOGS_PER_ZONE`, `MAX_GROUND_ITEMS_PER_ZONE`, and available floor so the UI can be abused without bypassing caps.
- **Ghost:** the Commands panel can summon the cosmetic ghost (a draped-sheet apparition; see [Avatars](#avatars-and-equipment)) at a server-picked random walkable tile in the caller's zone (behind `ghost-trogg`, fallback on). It fades in, drifts gently, lingers for a few seconds, and fades out. It inserts a capped `ghost_haunt` row so every live player in the map sees the same haunt; the row has no collision or durable gameplay effect, and late joiners ignore old rows.

### Identity

- Anonymous-first: SpacetimeDB issues each connection a cryptographic **Identity**; the browser stores the connection token it returns. Identity is the connection's own `ctx.sender` server-side, never client-asserted (invariant 3). Guests get a generated name `trogg-####` and exist within seconds, no signup.
- **Guest persistence:** the browser securely stores the SpacetimeDB connection token — not game state, which stays server-authoritative (invariant 3) — so a returning visitor reconnects with the same Identity and resumes the same trogg row with their progress intact. Clearing the browser or switching devices makes a guest a new trogg.
- **Surviving a redeploy:** the frontend and backend ship *independently* — the client to Cloudflare, the SpacetimeDB module to the VPS — so each deploy is handled on its own signal.
  - *Backend deploy:* SpacetimeDB is both the store and the live feed, so publishing a new module version closes every live socket at once. The client treats this as recoverable, not fatal: it shows a "reconnecting" overlay and probes for the server with exponential backoff + full jitter (jitter so the whole world doesn't stampede the instance the moment it restarts), then reloads once it's back. Because state is server-authoritative and re-derived from subscriptions, and the stored token resumes the same trogg, this loses nothing — players stay in the world across a deploy instead of being silently logged out. The reload also pulls the latest frontend as a side effect. Emits `connection_lost` (analytics.md).
  - *Frontend deploy:* a client-only deploy leaves the socket untouched, so there's no disconnect to react to. Each build is stamped (`__BUILD_ID__` + a shipped `version.json`); the client polls that stamp (every 60s and on tab focus) and, when a newer build is live, shows a dismissible "new version — refresh" prompt rather than forcing a reload — the old client keeps working against the unchanged backend, so the player refreshes when it suits them. Emits `client_update_available` (analytics.md).
- **Signing in** upgrades a guest to an account via **SpacetimeAuth** (SpacetimeDB's managed OIDC provider; Discord is the enabled login). SpacetimeDB derives a *stable* Identity from the OIDC token's `iss`+`sub`, so the account — not the browser — now anchors the synced state and the trogg resumes on any device. The browser runs the OIDC Authorization-Code-**+-PKCE** flow (a public client: no client secret in the bundle, invariant 8); the module trusts only the SpacetimeAuth issuer as an account provider (invariant 3). Account creation and the upgrade fire `player_named` alongside `posthog.identify()`, merging the guest's history.
- **Multiple live sessions for one account:** two tabs or devices signed into the same account share the same `player` row and therefore the same trogg. Any live session can send input; the other sessions simply observe the shared motion intent and render the trogg following it. Presence is tracked per socket in the private `player_connection` table, so opening a second session does not restart the trogg's movement, and closing one session does not mark the shared trogg offline while another session remains connected.
- **Claiming** (folding a guest's trogg into the account, since the two are different Identities): the guest's browser mints a one-time nonce, registers it under the guest Identity via `startClaim`, then signs in and redeems it as the account via `redeemClaim` — both sides proven, never a client-asserted identity (invariant 3). The guest's chosen name carries over (a generated `trogg-####` never overwrites a name the account already chose); the guest row is then absorbed. A fresh device with no guest just signs in and resumes the account directly. Nonces expire after `CLAIM_CODE_TTL_MS`.
- **Changing your name:** the `rename` reducer swaps the generated `trogg-####` for a chosen one, validated server-side. Names: unique, 3–20 chars, alphanumeric + hyphen. The new name takes effect everywhere it's shown — the nameplate over the trogg and the denormalised `name` on the player's past `chat_message` rows are both rewritten, so nothing keeps showing the old name.
- The account panel is an HTML/CSS HUD overlay — just the claim/sign-out button (rename, colour, and style live in the Appearance panel). Sign-in still uses the browser redirect to SpacetimeAuth.

### Skills and XP

- Skills exist per player, per skill, as accumulated XP. Level is derived, never stored.
- Total XP to reach level L: `50 × (L − 1)²` *(initial)* — level 2 at 50 XP, level 10 at 4,050.
- Level cap: 50 *(initial)*.
- First skills: **mining** and **foraging**. Crafting can arrive when recipes and inventory need it. No combat skills until defense events are specced.

### Gathering (nodes and actions)

- Clicking a node routes the trogg to the nearest reachable tile adjacent to it (nodes are unwalkable). On arrival the action starts: the server validates (adjacent, node available, no action in progress), writes the action with an end time, and schedules its completion server-side (`endsAt` persisted so it survives a restart).
- Completion grants the item + XP, flips the node to `depleted`, schedules its respawn. If the player walked away mid-action, the action cancels.
- One action at a time per player. Starting a new one cancels the old.

| Node type | Skill | Action time | XP | Item | Respawn |
| --------- | ----- | ----------- | -- | ---- | ------- |
| stone | mining | 3s *(initial)* | 10 *(initial)* | Stone | 30s *(initial)* |
| glowcap | foraging | 3s *(initial)* | 10 *(initial)* | Glowcap Mushroom | 30s *(initial)* |

New node types are added by extending this table — keep it the registry.

### Inventory

- The top-left Inventory icon (`I`) opens the inventory/equipment panel. Starter pickup items are seeded from the zone registry as `ground_item` rows; pressing `E` while facing one moves it into the player's inventory and removes the ground row.
- Inventory has 10 visible carry slots *(initial)*. The HUD always shows all slot outlines, filled first by owned inventory rows and then empty slots, so players can see remaining capacity at a glance.
- Inventory rows store an item id and quantity, and each row occupies one visible carry slot. Stackable items (Stone) merge into one row and can grow without consuming more slots; a stackable item with no existing stack needs one free slot to start. Equippable items (Pickaxe, Shovel, Sword, Shield) are non-stackable qty=1 rows, so two swords remain two visible slots and the equipped row is unambiguous.
- Items are defined in a static registry (id, name, stackable, blurb). Holdable/wearable items also carry their slot and sprite. No item randomization.
- Equipping sets the slot the item belongs to — `equippedMainHand`/`equippedMainHandInventoryId` for tools and weapons, `equippedOffHand`/`equippedOffHandInventoryId` for shields — to an owned row (the item stays counted in inventory; equipment just references it). The reducer routes by the item's `slot`, so the two hands equip independently; equipping the row already in its slot toggles it off, and `0` clears both hands. See [Avatars and equipment](#avatars-and-equipment).
- Selecting an inventory slot opens its actions: equip/unequip (equippables only, into the item's hand), **drop**, and **delete**. Both drop and delete act on one unit — a stack decrements, a qty=1 row is removed; removing the equipped row unequips it. Drop lays that unit back into the world as a `ground_item` on the faced tile, the nearest free neighbour, or the trogg's own tile (the carried put-down placement), honouring `MAX_GROUND_ITEMS_PER_ZONE`; a full or boxed-in zone refuses the drop and keeps the item. Delete destroys the unit outright with no ground item, behind a confirm step in the panel.

### Combat

Pre-alpha combat is deliberately small and tile-based. Troggs and roaming Hogs are the current damageable characters; future PvE defense events use the same slow, stat-driven grammar rather than twitch mechanics.

- **Health:** each trogg has `PLAYER_MAX_HEALTH` (100 *(initial)*) health points. Health rides the `player` row, so everyone sees the same health bar and death state from server truth.
- **Hog health:** each roaming Hog has `HOG_MAX_HEALTH` (60 *(initial)*) health points on the `hog` row. Damaged Hogs show a small health bar; at zero health the Hog row is removed from the world.
- **Sword attacks:** pressing `F` with a sword equipped damages the online, living trogg on the faced adjacent tile by `SWORD_DAMAGE` (25 *(initial)*). If no trogg is on that tile, the same swing damages the faced Hog — a big 2×2 Hog answers for any of its four footprint tiles, so a giant takes a hit on its body, not only its anchor. The client passes its current facing, but the server re-derives the attacker's tile, projects candidate targets, excludes the attacker, and only applies damage to a target actually on that adjacent tile (invariant 3).
- **Thrown boulders and Hogs:** pressing `F` while carrying a boulder or Hog throws it in a straight cardinal line up to `THROWN_OBJECT_RANGE` (4 tiles *(initial)*). It damages the first online, living trogg or Hog it hits by `THROWN_OBJECT_DAMAGE` (40 *(initial)*) and then lands near the impact; if it hits no damageable character, it lands at the farthest clear tile before range or a blocker. This is still an input-driven reducer, not a projectile simulation.
- **No twitch checks:** combat has no projectiles, hitboxes, physics, cursor aiming, or per-frame attack checks.
- **Death:** when damage takes a trogg to zero health, the server marks it `dead`, stops its motion on its current tile, and leaves it online so other players can see it. Dead troggs cannot move, push, interact, spawn objects, or use equipment. If a dying trogg is carrying a tile-sized object, the server tries to drop it at the death tile so nothing is orphaned. Every inventory row, including equipped items, is removed from the trogg and dropped as `ground_item` rows nearby; stack quantities are preserved.
- **Respawn:** death stamps `respawnAt` five seconds in the future (`PLAYER_RESPAWN_MS`, 5000 *(initial)*) and inserts a one-shot `player_respawn` scheduled row. Dead troggs show a visible respawn countdown. When the timer fires, the same `player` row returns to the zone spawn at full health with the same name, colour, and style.

### Crafting

- Recipes: inputs → output, optional skill/level requirement, crafted at stations in the Hog town (e.g., torches, better picks).
- Better tools gather faster or unlock harder node types — the progression spine.

### Communal construction

- Projects the whole tribe contributes resources to ("the beacon needs 500 stone"), with a public progress bar. Completion unlocks a zone, station, or capability for everyone.
- Contributions are per-player tracked (leaderboards, achievements); the unlock is shared.

### Hog merchants and economy

- Hog NPCs can buy and sell at fixed prices in town. Player trading, if added, is a transactional mutation under contention — both inventories checked and mutated atomically.
- Currency: TBD (working name: shards).

### Defense events

- Things come out of the dark; the tribe defends the Hogs. Event-based PvE combat: scheduled waves, slow stat-driven resolution, click-to-engage. No projectiles, no physics, no real-time aiming — ever (invariant 7).

### AI inhabitants

- LLM-driven Hog NPCs with real dialogue (merchants, quest-giver-ish townsfolk). Every interaction is an LLM call traced with AI observability.

## Data model

One layer. **SpacetimeDB** is the durable store *and* the live feed: the tables below are the source of truth, and clients subscribe directly to the rows in their current zone — there is no separate cache or room projection to keep in sync. Only trusted module entrypoints may write: reducers for pure game mutations and procedure wrappers that open a SpacetimeDB transaction with `ctx.withTx(...)` before doing external telemetry. The writer's identity is the connection's own `ctx.sender` (invariant 3). A connecting client upserts its `player` row (`clientConnected`) and settles it on disconnect (`clientDisconnected`); SpacetimeDB persists every table, so a returning Identity resumes its trogg with no hydrate step. Motion intents (direction, `movedAt`) live in the durable row, but position is still *derived* from them with `projectMotion`, never advanced on a timer — the no-teleport-by-quit rule holds (invariant 1). A zone with no connected players produces no diffs and no work. Indexes noted where the access pattern demands them.

Dev mirrors prod: a local `spacetime start` instance runs the very module production runs — `just dev` publishes to it and regenerates the client bindings — so persistence is exercised the same way it runs in production. No Docker, no separate database to provision.

```text
player         identity (PK), name, isGuest, zoneId, x, y, dirX, dirY, movedAt, online, lastChatAt, running, color, carrying, path, style, equippedMainHand, equipmentAction, equipmentActionAt, equippedMainHandInventoryId, faceX, faceY, carryingStyle, health, dead, respawnAt, equippedOffHand, equippedOffHandInventoryId
               keyed by the connection's Identity. motion derived from origin (x,y) + movedAt: WASD uses
               dirX/dirY (0,0 = idle); running (shift held) picks run speed over walk speed in projectMotion,
               so it rides the intent like direction; click-to-move stores `path` as serialized waypoint tiles
               (`"x,y;x,y;..."`, empty = no path). online: in-zone
               presence — clients subscribe to online players, so a disconnect settles the row and drops it
               from view without losing progress. lastChatAt: per-player chat rate limit. color: chosen
               TROGG_COLORS palette index (COLOR_UNSET = -1 → colour derived from id; see "Avatars").
               carrying: kind of tile-sized entity the trogg holds ("" = none), set by `interact`; the held
               entity's own row is removed while carried and re-inserted on put-down (see "Interacting").
               carryingStyle: carried entity visual variant; currently used only for Hog skins so carrying
               and putting down a Hog preserves its look even though the Hog row is replaced.
               style: chosen TROGG_STYLES index (STYLE_UNSET = -1 → style derived from id; see "Avatars"),
               set by `restyle`. equippedMainHand/equippedOffHand: equipped item id per hand ("" = none);
               equippedMainHandInventoryId/equippedOffHandInventoryId: the specific owned inventory row
               equipped in that hand (0 = none).
               equipmentAction/equipmentActionAt: last synced use impulse for animation. faceX/faceY:
               standing facing, separate from movement intent so idle turns sync without deriving position.
               health/dead/respawnAt: combat state; dead troggs stay online but cannot act while
               the respawn countdown is active. `player_respawn` returns them to spawn after `respawnAt`.
               Columns are appended in migration order (the off-hand pair is the current tail), so the
               shipped layout is never reordered; see module source.
               index: by_zone (zoneId)
zones          slug, name, width, height, tilemap (per-tile walkability + scenery), checkpoint (unlock tile, null if none)
               index: by_slug (slug)
               deferred — zone definitions currently live in a static code registry (ZONES in shared); this table lands when tilemaps need editable storage
nodes          type, zoneId, x, y, state ("available" | "depleted"), respawnAt
               index: by_zone (zoneId)
boulder        id (PK, auto-inc), zoneId, x, y     (tile coords)
               a pushable rock on an unwalkable tile; clients subscribe per zone and treat it as a
               dynamic obstacle. Seeded from the ZONES registry on first connect, moved only by `push`
               (or reset to the registry by the `resetBoulders` reducer, fired by the Commands panel).
               Removed while a trogg carries it and re-inserted on put-down (see "Interacting").
               index: by_zone (zoneId)
hog            id (PK, auto-inc), zoneId, x, y, dirX, dirY, movedAt, path, homeX, homeY, style, health
               an ambient roaming Hog NPC (see "Hogs"). Intent-based motion like a player (position
               derived with projectMotion); server-owned, no identity. Solid: blocks troggs and other
               Hogs (troggs never block each other), so wanderHogs re-bases it tile by tile, stopping
               flush against anything solid. dirX/dirY is its cardinal amble heading; path/homeX/homeY are
               retained columns from the earlier pathfinding wander, unused by the tile-by-tile amble and
               kept only so the shipped schema isn't reordered. style: "" = common roamer (id-derived
               skin); "buff"/"dino" = a 2×2 showpiece; "chicken" = easter egg; or any concrete HOG_STYLES
               id for exact Commands panel spawns and carried-and-dropped Hogs preserving their look.
               hogSize(style) gives the footprint span (appended last per the migration note). Seeded from
               the ZONES registry on first connect, spawned by the Commands panel, moved only by the scheduled
               `wanderHogs` (or reset to the registry population by the `resetHogs` reducer, fired by the Commands panel).
               `health` makes Hogs damageable; zero health deletes the row. Removed while a trogg carries
               it and re-inserted on put-down (see "Interacting").
               index: by_zone (zoneId)
ground_item    id (PK, auto-inc), zoneId, item, x, y, qty
               a pickup item lying on the floor. Seeded from the ZONES registry on first connect, spawnable one at
               a time from the Commands panel only when its id is in SPAWNABLE_ITEM_IDS, and removed by `interact`
               when a trogg faces it and presses `E`. `qty` preserves dropped stack counts when a dead trogg
               drops inventory. Items are not solid. index: by_zone (zoneId)
inventory      id (PK, auto-inc), playerId, item, qty
               player-owned items. Each row occupies one of 10 visible carry slots. Stackable rows merge
               and can grow in-place; starting a new stack or adding a non-stackable item requires a free
               slot. Non-stackable equippables stay separate qty=1 rows so equipment can point at one
               specific owned row. index: by_player (playerId)
player_connection connectionId (PK), playerId, connectedAt
               private live-socket presence for a `player` row. Multiple browser tabs or devices signed
               into the same account share one durable `player` row, so this table tracks the connection
               ids behind that identity. `clientConnected` inserts the socket; `clientDisconnected`
               removes it and only settles/drops/marks the trogg offline when no connections remain.
               index: by_player (playerId)
player_respawn scheduledId (PK), playerId, scheduledAt
               private one-shot scheduled rows inserted on trogg death. The scheduled `respawnPlayers`
               reducer re-checks `player.dead` and `player.respawnAt`, then returns the same `player`
               row to zone spawn at full health while preserving name, colour, style, and identity.
hog_wander     scheduledId (PK, auto-inc), scheduledAt     (scheduled table)
               the Hog wander timer — SpacetimeDB's deterministic scheduler (invariant 1). Fires
               `wanderHogs`, which re-arms it only while a player is online. Private (no client reads it).
ghost_haunt    id (PK, auto-inc), zoneId, x, y, createdAt
               a zone-scoped cosmetic fanout event for the ghost. `hauntGhost` chooses a random
               walkable tile server-side, inserts the row, and trims each zone to
               GHOST_HAUNT_HISTORY_MAX. Clients subscribe per zone and render fresh inserts only,
               so everyone already in the map sees it once and late joiners don't replay old haunts.
               index: by_zone (zoneId)
actions        playerId, nodeId, kind, startedAt, endsAt
               index: by_player (playerId)
chat_message   id (PK, auto-inc), zoneId, sender (Identity), name (denormalised), text, createdAt
               a new row is the live bubble; clients subscribe to recent rows per zone, capped at
               CHAT_HISTORY_MAX (trimmed in the chat reducer). `rename` rewrites `name` across the
               sender's rows so history tracks the current name. index: by_zone (zoneId)
claim_code     code (PK), guest (Identity), createdAt
               a pending guest → account claim (see "Identity"). Private (not public): the nonce lives
               only in the browser that minted it; no client reads this table. startClaim writes it under
               the guest Identity; redeemClaim consumes it as the account. Stale after CLAIM_CODE_TTL_MS.
skills         playerId, skill, xp
               index: by_player (playerId)
projects       slug, zoneId, status, requirements, contributed
               index: by_zone (zoneId)
```

## Multiplayer scaling stance

- **One subscription per zone, naive within it.** A client subscribes to the rows of its current zone; SpacetimeDB pushes row diffs to everyone subscribed. Within a zone there's no interest management and no instancing — everyone sees every player.
- **Fixed cost, watched in metrics.** The VPS runs the self-hosted SpacetimeDB instance on a flat monthly bill, not a usage meter, so the concern is CPU, memory, and bandwidth — watched via server metrics and PostHog, not an egress invoice. At the realistic scale (tens of concurrent) a single instance on a small Hetzner box is ample.
- **Capacity cap before launch.** Connection and subscription limits are set so a viral night sheds or queues load instead of toppling the box; vertical scale (a bigger VPS) is the first lever. Per-zone entity caps (`MAX_HOGS_PER_ZONE`, `MAX_BOULDERS_PER_ZONE`, `MAX_GROUND_ITEMS_PER_ZONE`) bound Commands panel spawns and carried-object drops server-side, so no client can flood a zone and inflate every `wanderHogs` tick.
- **The answer key, only when a graph demands it:** narrow the subscription with area-of-interest SQL filters (a smaller `WHERE` per client), crowd aggregation above a density threshold, and — when one box isn't enough — SpacetimeDB's own horizontal scaling. None of these are built in advance.
- **Same module, dev to prod.** The instance the VPS runs is the module that runs locally, mirrored from the current production module. Running beyond a single instance — and everything else in the answer key — stays deferred under invariant 10.
- **Swappable position feed:** the client reads positions through the zone subscription and writes through reducers, both in one place. Tightening to area-of-interest is a query change, not a rewrite.

## Invariants (non-negotiable)

1. No simulation tick. We never run a server simulation loop; state changes only inside a reducer — on player input or a scheduled reducer (SpacetimeDB's deterministic timer, used for respawns and action completions). SpacetimeDB sends only row diffs to subscribers, so an unchanged table produces none and a zone with no connected players computes nothing.
2. No per-frame or per-tile server sync. Movement intents (click→path, key down/up, direction change) are sent via reducers; clients derive and predict motion locally. Synced player state changes on input, never on a timer or every frame.
3. All authoritative state lives on the server — SpacetimeDB's durable tables, written only by reducers or procedure transactions, with the writer identified by `ctx.sender`. Never trust the client.
4. Analytics events are low-volume and never contain chat content or PII beyond the player name (full rules in [analytics.md](analytics.md)).
5. Feature flags are operational controls, not a blanket requirement. Add or configure one when a feature needs remote rollout, a kill-switch, an experiment, or live tuning; otherwise keep the code simple. Any flag key the code reads must be registered in [analytics.md](analytics.md) with its fallback behavior, and the matching PostHog flag must be created or updated in the configured project during the same task.
6. The game is playable at the end of every session. No half-wired states on `main`.
7. No twitch combat: combat is tile-based, stat-driven, and slow — no projectiles, physics, real-time aiming, or per-frame attack checks. No procedural generation.
8. No secrets in the repo — env vars only, `.env*` is gitignored. This repo is public.
9. Glossary names are canonical across code, schema, events, and UI.
10. No preemptive scaling work. Optimizations from the scaling answer key are built only when a dashboard graph justifies them. No instancing below ~1,000 concurrent in a zone.

## Roadmap and current state

Roadmap notes are planning context, not permission gates. Pick work by current product need, maintainer direction, and what keeps the game playable. Do not block a task because older notes placed it later, and do not treat this section as a release checklist.

Current playable foundation: durable SpacetimeDB tables are the store, anonymous SpacetimeDB Identity gives each browser a persistent trogg, and optional SpacetimeAuth OIDC lets a guest claim an account with `startClaim`/`redeemClaim`, `rename`, `player_named`, and `posthog.identify()`. Identity is issued by the connection and module entrypoints authorize by `ctx.sender`; it is never client-asserted. Multiple live sockets for the same account share one trogg and are tracked through private per-connection presence.

Implemented world systems: a static shared `ZONES` registry, zone-scoped subscriptions, per-tile walkability, cardinal grid-locked WASD movement, boulder pushing, pick-up-and-carry interaction (`E`), throwable boulders/Hogs, starter tool pickups, inventory/equipment with `I`, equipped-item use with `F`, sword attacks, trogg and Hog health, death drops, timed respawn, roaming Hogs, hold-shift-to-run, sprite avatars, trogg recolouring/restyling via Appearance (`P`), chat bubbles/history, a small synced ghost-trogg cosmetic (Commands panel summon), a help panel listing live controls, and a pre-alpha Commands panel for one-click spawn/reset/ghost tools. Some of these have optional client-side flag gates for remote rollout or kill-switch use; the current code-read flags are configured in PostHog and still have code fallbacks for local or unconfigured environments.

Likely next work areas include starting-zone onboarding, click-to-move pathfinding around obstacles, gathering and XP, crafting, communal projects, Hog merchants, load events, LLM-driven Hogs, and optional PvE defense. These are intentionally fluid; implement the slice that best serves the current task.

## Open design threads

- Mascot integration: concept-inspired trogg/Hog sprite art has landed (`shared/sprite_art.ts` + `shared/sprites.ts` → `assets/sprites/`, rendered for troggs behind `avatar-sprites`), with rig-driven limbs, the attack swing, and held main/off-hand item overlays. Further work is polish: richer poses, the layered armour/cosmetic stack (see "Layered avatars and cross-species equipment"), and any artist-authored source pipeline if the project outgrows indexed code-authored pixel art.
- Tilemap and pixel asset direction once the colored grid stops being charming.
- Light/darkness as a mechanic: torch radius, communal beacons, dark-gated zones — how literal to make it.
- Own-avatar prediction polish: basic optimistic acknowledgement handling has landed for movement; richer rollback/smoothing is deferred until playtests show a need.
- Currency design.
