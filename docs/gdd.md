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
- **Tap to turn, hold to walk (the Pokémon pivot):** from a standstill, pressing a direction you don't face turns the trogg in place — a quick tap only turns, while holding turns and then begins walking after a short beat (`TURN_TAP_MS` *(initial)*). Pressing the direction you already face walks at once. While already moving, a new direction corners fluidly with no turn-in-place beat. This is why a boulder isn't shoved just by facing it: from a stop you tap to face it, then press in to push (GDD "Pushing"). The in-place facing is a client-side display nicety for now — others see your heading when you next move; syncing the standing facing is a small follow-up.

Both are **input-driven, not per-frame.** The client writes a movement intent only on input transitions — a click (which sets a path), a key down/up, or a direction change — never on a timer or every frame. For grid-lock, the client holds a turn or stop until its predicted avatar reaches the next tile centre, then sends the intent (it detects the centre from its own prediction — a motion transition, not a per-frame sync; the same pattern `push` uses). The server stores each player's motion as an origin `(x, y)`, a direction or a path, and `movedAt`; position over time is derived from these, and clients render it locally between updates.

- Move speed: 4 tiles/sec *(initial)*, shared by both modes. A click overrides held keys and vice versa.
- **Running:** holding **shift** while moving runs at `RUN_SPEED_TILES_PER_SEC` (7 tiles/sec *(initial)*) instead of walking, controlled by the optional `running` flag (off → shift is ignored, movement stays at walk speed). Run state rides the synced motion intent (`player.running`), so `projectMotion` derives the same faster position on every client — no per-frame sync, no determinism mismatch (invariants 2 & 3). Releasing shift, stopping, or a change of direction re-bases the origin at the current speed (the `move` reducer settles before storing the new intent). Troggs show a faster, hunched run animation (`run_a`/`run_b` in `shared/sprites.ts`); Hogs always walk.
- **Obstacles:** tiles carry a walkability flag; nodes and scenery (trees, rocks, walls) sit on unwalkable tiles. WASD clamps at the first unwalkable tile or the zone edge; click-to-move routes around them.
- **Pathfinding:** the server runs grid `A*` over the zone's walkable tiles on each click, stores the resulting `path` on the player, and clients animate along that synced path — no client-side recompute, so no determinism mismatch to manage. An obstacle-free zone degenerates to a straight line. The algorithm runs server-side in the room on each click — a small hand-rolled grid `A*` or a battle-tested JS lib (PathFinding.js, easystarjs).
- **No teleport-by-quit.** The stored `(x, y)` is the *origin* of the current move, never the destination. Position is only advanced by elapsed real time × speed along `path`, so clicking far away and quitting skips nothing — on return you're wherever the clock puts you (arrived only if enough time actually passed). A scheduled task may settle `(x, y)` to the path's end at `movedAt + traveltime`, but never before it.
- **Prediction (display only):** because clients sync *intents*, not positions, every client derives the same motion locally and animates other troggs continuously from their last known intent — no per-frame position sync. Clients map the server's `movedAt` onto their local monotonic clock so deployed latency does not make avatars trail their authoritative motion by a round trip. The local player's own accepted input is applied optimistically to display state at the tile centre where it was sent; a matching server row is treated as an acknowledgement and does not restart the animation, while a mismatching row still snaps to server truth (invariant 3).

### Pushing

Boulders are pushable rocks — dynamic obstacles, the same block-pushing grammar as classic top-down games. Walkability is the static tilemap **minus** the tiles boulders occupy, so the very collision that stops a trogg at a wall stops it flush at a boulder.

- **A push is walking *into* a boulder, not arriving beside one.** Hold a direction into a boulder you face and it slides ahead of you, one tile at a time, for as long as you keep pushing — like walking. Releasing as you reach it stops the trogg flush against it like a wall (it's an occupied tile), no shove; tap-to-turn (see "Movement") means you face it deliberately first, so you never shove something you only brushed past. The trogg must be **tile-aligned and flush**, and the tile beyond the boulder must be open floor (no wall, no other boulder).
- **No tick** (invariant 1) and **server-authoritative** (invariant 3). The client fires `push` off its own prediction — the moment the trogg, moving in a committed direction (not merely facing one), becomes flush against a boulder (a motion transition, once per tile — never per frame, invariant 2). The server re-derives the trogg's position from its stored intent, validates alignment + a clear destination, moves the boulder one tile, and re-bases the trogg's motion to the flush tile.
- **Cadence falls out of walk speed.** Re-basing leaves the boulder one tile ahead, and the trogg follows into the vacated tile before it's flush again — so the boulder advances at most one tile per tile walked, and a held key gives a steady slide at walk speed, never faster. Spamming `push` can't help: the boulder isn't faced again until the trogg catches up.
- Boulders start from the zone's `boulders` registry entry, seeded into the `boulder` table on first connect, then moved only by `push`. The optional `boulder-pushing` flag can turn this off remotely: off → immovable rocks; on → pushable. Playable either way (invariant 6).
- **Resetting:** the in-chat `/reset` command snaps the player's current zone back to its registry boulder layout (the `resetBoulders` reducer clears and reseeds the zone). Behind the `boulder-reset` flag — off, `/reset` is just an ordinary chat line.

### Hogs (roaming)

Ambient **Hog** NPCs (the glossary's friendly hedgehogs) roam the zone on their own — decorative life in the world, controlled by the optional `roaming-hogs` flag (off → no Hogs). This is presence and movement only: no dialogue, trade, or interaction. Merchant, townsfolk, and dialogue roles are separate later work.

- **Same motion model as troggs.** A Hog carries an intent — origin `(x, y)`, a cardinal direction, `movedAt` — and clients derive its position with `projectMotion`, so it's never per-frame synced (invariant 2) and it collides against the same walls and boulders.
- **Driven by a scheduled reducer, not a tick.** A Hog changes heading only inside the scheduled `wanderHogs` reducer (SpacetimeDB's deterministic timer — the sanctioned exception in invariant 1, like respawns). Each tick re-derives every Hog's position and picks a fresh heading: a random walkable cardinal, or idle with chance `HOG_IDLE_CHANCE` so they pause. Randomness is the context RNG (seeded from the tick timestamp), so the schedule replays deterministically (invariant 3).
- **Empty zone, no work.** The timer re-arms only while a player is online; when the last player leaves, the next tick settles every Hog to rest and stops, so an empty world produces no diffs and no work (invariant 1).
- **Server-owned, seeded from the registry.** Hogs have no identity. Their starting tiles come from the zone's `hogs` registry entry (`ZONES` in `shared`), seeded into the `hog` table on first connect (idempotent, like boulders), then moved only by `wanderHogs`.
- Wander cadence: a new heading every `HOG_WANDER_INTERVAL_MS` *(initial)*, at the shared move speed.

### Camera and rendering

- 3/4 top-down (RuneScape-2004 / Stardew view), pixel art tiles and sprites.
- Rendered with **PixiJS** (WebGL/WebGPU canvas) on a Vite + TypeScript client, nearest-neighbour scaled for crisp pixels. The client subscribes to the zone's SpacetimeDB tables and draws them; all authority stays server-side (invariant 3).

### Avatars and equipment

- A trogg (and a Hog) is a **layered sprite**: a base body plus composable overlay layers, drawn per facing (down/up/left/right) and per animation frame (idle/walk). Troggs and Hogs share the rig, so equipment renders the same on either.
- **Held items** (torch, pick, axe, sword, shield) render as per-hand layers — a **main hand** and an **off hand**, so combinations like sword + shield work. Each hand has its own anchor point and z-order per direction/frame (e.g. the off-hand arm and its item sit behind the body when facing up, in front when facing down). A new holdable is a new item sprite, not a new character.
- **Armor (later)** layers the same way over body slots (head, torso). The rig reserves the layer order now; armor sprites are added with the mechanic.
- What's equipped rides the zone's player sync, so others see what you're holding. Held-item rendering can land with tools; the model is built extensible from the first sprite.
- **Sprite avatars (`avatar-sprites`):** a trogg renders as the layered avatar sprite — programmer pixel art generated from `shared/sprites.ts` (4 facings × idle/walk/run, troggs and Hogs sharing one rig), feet anchored at the centre of the tile (not its bottom edge, so a grid-locked trogg stands in the middle of its tile). The per-trogg colour rides as a sprite **tint**, so the same trogg is the same colour for everyone, every session; your own trogg gets a ground ring so you can pick it out. The committed sprite sheet asset (`assets/sprites/`) is the reviewable export; the client paints the same art into a texture at runtime.
- **Placeholder marker (kill-switch fallback):** with `avatar-sprites` off, a trogg draws as a solid tile-filling marker in its colour (own trogg outlined) — the original placeholder, kept as the flag's fallback.
- **Trogg colour (`trogg-recolor`):** the tint comes from a fixed palette (`TROGG_COLORS` in `shared`). A trogg picks one via the `recolor` reducer, which stores its chosen palette index on the `player` row (validated server-side, invariant 3); until it chooses, the colour falls back to a stable default derived from its durable id (a deterministic projection, like a level from XP — `COLOR_UNSET` is the unchosen sentinel). The chosen colour rides the zone player sync, so the tint and the trogg's chat-name colour update everywhere it's shown. The optional flag controls whether the palette swatches show in the account panel beside rename.

### Zones

- A zone has a slug, display name, integer width/height in tiles, and a tilemap: per-tile walkability plus scenery. Nodes and obstacles sit on unwalkable tiles.
- **Zone definitions are a static code registry** (`ZONES` in `shared`, keyed by slug) — static design data like the item and node registries, not the durable `zones` table the data model lists. The table is deferred until tilemaps need editable storage; until then a zone is a registry entry. A client subscribes to one zone's rows by slug (`WHERE zone_id = …`); zone dimensions and the per-tile walkability tilemap (`tiles`, read through `isWalkable`) come from the shared `ZONES` registry (imported by both the client and the module), so the grid is shared design data, not a per-session value. The client renders walls from the same tilemap it collides against, so what's drawn is what blocks you.
- **Spawn and the hub gate:** new players spawn in a shared **starting zone** (working name: the cave) and must reach a checkpoint to unlock the hub, `hog-town`. The hub isn't available until the checkpoint is crossed — a per-player progression gate, not an instance; the starting zone is shared like any other.
- The current world ships a single shared zone *(working slug `hog-town`, 24×16 (initial))*; additional zones, starting areas, and gates can be added when they help the current gameplay.
- Clients subscribe to players/nodes/chat **in their current zone only**. Within a zone, sync is deliberately naive (whole-zone queries) — see invariant 10.
- New zones ship incrementally; transitions are walk-to-edge or interact-with-passage. How later areas gate (checkpoints, light, communal projects) is an open thread.

### Chat

- Zone-scoped. Max 200 chars *(initial)*. Bubble displays 5s *(initial)*; side panel keeps recent history.
- Server-side rate limit: 1 message/sec per player *(initial)*.
- Message content is **never** sent to analytics.

### Identity

- Anonymous-first: SpacetimeDB issues each connection a cryptographic **Identity**; the browser stores the connection token it returns. Identity is the connection's own `ctx.sender` server-side, never client-asserted (invariant 3). Guests get a generated name `trogg-####` and exist within seconds, no signup.
- **Guest persistence:** the browser securely stores the SpacetimeDB connection token — not game state, which stays server-authoritative (invariant 3) — so a returning visitor reconnects with the same Identity and resumes the same trogg row with their progress intact. Clearing the browser or switching devices makes a guest a new trogg.
- **Signing in** upgrades a guest to an account via **SpacetimeAuth** (SpacetimeDB's managed OIDC provider; Discord is the enabled login). SpacetimeDB derives a *stable* Identity from the OIDC token's `iss`+`sub`, so the account — not the browser — now anchors the synced state and the trogg resumes on any device. The browser runs the OIDC Authorization-Code-**+-PKCE** flow (a public client: no client secret in the bundle, invariant 8); the module trusts only the SpacetimeAuth issuer as an account provider (invariant 3). Account creation and the upgrade fire `player_named` alongside `posthog.identify()`, merging the guest's history.
- **Claiming** (folding a guest's trogg into the account, since the two are different Identities): the guest's browser mints a one-time nonce, registers it under the guest Identity via `startClaim`, then signs in and redeems it as the account via `redeemClaim` — both sides proven, never a client-asserted identity (invariant 3). The guest's chosen name carries over (a generated `trogg-####` never overwrites a name the account already chose); the guest row is then absorbed. A fresh device with no guest just signs in and resumes the account directly. Nonces expire after `CLAIM_CODE_TTL_MS`.
- **Changing your name:** the `rename` reducer swaps the generated `trogg-####` for a chosen one, validated server-side. Names: unique, 3–20 chars, alphanumeric + hyphen. The new name takes effect everywhere it's shown — the nameplate over the trogg and the denormalised `name` on the player's past `chat_message` rows are both rewritten, so nothing keeps showing the old name.

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

- 24 slots *(initial)*, stackable items (item id + qty per slot).
- Items are defined in a static registry (id, name, stackable, blurb). Holdable/wearable items also carry their slot and sprite. No item randomization.
- Equipping sets a `players.equipment` slot to an owned item (the item stays counted in inventory; equipment just references it). See [Avatars and equipment](#avatars-and-equipment).

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

- PvE only. Things come out of the dark; the tribe defends the Hogs. Event-based combat: scheduled waves, slow stat-driven resolution, click-to-engage. No projectiles, no physics, no real-time aiming — ever (invariant 7).

### AI inhabitants

- LLM-driven Hog NPCs with real dialogue (merchants, quest-giver-ish townsfolk). Every interaction is an LLM call traced with AI observability.

## Data model

One layer. **SpacetimeDB** is the durable store *and* the live feed: the tables below are the source of truth, and clients subscribe directly to the rows in their current zone — there is no separate cache or room projection to keep in sync. Only **reducers** (transactional server functions) may write, and the writer's identity is the connection's own `ctx.sender` (invariant 3). A connecting client upserts its `player` row (`clientConnected`) and settles it on disconnect (`clientDisconnected`); SpacetimeDB persists every table, so a returning Identity resumes its trogg with no hydrate step. Motion intents (direction, `movedAt`) live in the durable row, but position is still *derived* from them with `projectMotion`, never advanced on a timer — the no-teleport-by-quit rule holds (invariant 1). A zone with no connected players produces no diffs and no work. Indexes noted where the access pattern demands them.

Dev mirrors prod: a local `spacetime start` instance runs the very module production runs — `just dev` publishes to it and regenerates the client bindings — so persistence is exercised the same way it runs in production. No Docker, no separate database to provision.

```text
player         identity (PK), name, isGuest, zoneId, x, y, dirX, dirY, running, movedAt, online, lastChatAt, color, hubUnlocked, equipment
               keyed by the connection's Identity. motion derived from origin (x,y) + movedAt: WASD uses
               dirX/dirY (0,0 = idle); running (shift held) picks run speed over walk speed in projectMotion,
               so it rides the intent like direction; click-to-move can add `path` (waypoint tiles). online: in-zone
               presence — clients subscribe to online players, so a disconnect settles the row and drops it
               from view without losing progress. lastChatAt: per-player chat rate limit. color: chosen
               TROGG_COLORS palette index (COLOR_UNSET = -1 → colour derived from id; see "Avatars").
               hubUnlocked: checkpoint gate. equipment: slot → item map, multiple slots at once (e.g. { mainHand: "sword",
               offHand: "shield" }; armor slots later) — rides the zone subscription so others see it
               index: by_zone (zoneId)
zones          slug, name, width, height, tilemap (per-tile walkability + scenery), checkpoint (unlock tile, null if none)
               index: by_slug (slug)
               deferred — zone definitions currently live in a static code registry (ZONES in shared); this table lands when tilemaps need editable storage
nodes          type, zoneId, x, y, state ("available" | "depleted"), respawnAt
               index: by_zone (zoneId)
boulder        id (PK, auto-inc), zoneId, x, y     (tile coords)
               a pushable rock on an unwalkable tile; clients subscribe per zone and treat it as a
               dynamic obstacle. Seeded from the ZONES registry on first connect, moved only by `push`
               (or reset to the registry by the `resetBoulders` reducer, fired by the in-chat `/reset` command).
               index: by_zone (zoneId)
hog            id (PK, auto-inc), zoneId, x, y, dirX, dirY, movedAt
               an ambient roaming Hog NPC (see "Hogs"). Intent-based motion like a player (position
               derived with projectMotion); server-owned, no identity. Seeded from the ZONES registry
               on first connect, dropped by the `/spawn` debug command, moved only by the scheduled
               `wanderHogs`. index: by_zone (zoneId)
hog_wander     scheduledId (PK, auto-inc), scheduledAt     (scheduled table)
               the Hog wander timer — SpacetimeDB's deterministic scheduler (invariant 1). Fires
               `wanderHogs`, which re-arms it only while a player is online. Private (no client reads it).
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
inventories    playerId, item, qty
               index: by_player (playerId)
projects       slug, zoneId, status, requirements, contributed
               index: by_zone (zoneId)
```

## Multiplayer scaling stance

- **One subscription per zone, naive within it.** A client subscribes to the rows of its current zone; SpacetimeDB pushes row diffs to everyone subscribed. Within a zone there's no interest management and no instancing — everyone sees every player.
- **Fixed cost, watched in metrics.** The VPS runs the self-hosted SpacetimeDB instance on a flat monthly bill, not a usage meter, so the concern is CPU, memory, and bandwidth — watched via server metrics and PostHog, not an egress invoice. At the realistic scale (tens of concurrent) a single instance on a small Hetzner box is ample.
- **Capacity cap before launch.** Connection and subscription limits are set so a viral night sheds or queues load instead of toppling the box; vertical scale (a bigger VPS) is the first lever.
- **The answer key, only when a graph demands it:** narrow the subscription with area-of-interest SQL filters (a smaller `WHERE` per client), crowd aggregation above a density threshold, and — when one box isn't enough — SpacetimeDB's own horizontal scaling. None of these are built in advance.
- **Same module, dev to prod.** The instance the VPS runs is the module that runs locally, mirrored from the current production module. Running beyond a single instance — and everything else in the answer key — stays deferred under invariant 10.
- **Swappable position feed:** the client reads positions through the zone subscription and writes through reducers, both in one place. Tightening to area-of-interest is a query change, not a rewrite.

## Invariants (non-negotiable)

1. No simulation tick. We never run a server simulation loop; state changes only inside a reducer — on player input or a scheduled reducer (SpacetimeDB's deterministic timer, used for respawns and action completions). SpacetimeDB sends only row diffs to subscribers, so an unchanged table produces none and a zone with no connected players computes nothing.
2. No per-frame or per-tile server sync. Movement intents (click→path, key down/up, direction change) are sent via reducers; clients derive and predict motion locally. Synced player state changes on input, never on a timer or every frame.
3. All authoritative state lives on the server — SpacetimeDB's durable tables, written only by reducers, with the writer identified by `ctx.sender`. Never trust the client.
4. Analytics events are low-volume and never contain chat content or PII beyond the player name (full rules in [analytics.md](analytics.md)).
5. Feature flags are operational controls, not a blanket requirement. Add or configure one when a feature needs remote rollout, a kill-switch, an experiment, or live tuning; otherwise keep the code simple. Any flag key the code reads must be registered in [analytics.md](analytics.md) with its fallback behavior.
6. The game is playable at the end of every session. No half-wired states on `main`.
7. No PvP. No twitch combat: any PvE is event-based, stat-driven, and slow — no projectiles, physics, or real-time aiming. No procedural generation.
8. No secrets in the repo — env vars only, `.env*` is gitignored. This repo is public.
9. Glossary names are canonical across code, schema, events, and UI.
10. No preemptive scaling work. Optimizations from the scaling answer key are built only when a dashboard graph justifies them. No instancing below ~1,000 concurrent in a zone.

## Roadmap and current state

Roadmap notes are planning context, not permission gates. Pick work by current product need, maintainer direction, and what keeps the game playable. Do not block a task because older notes placed it later, and do not treat this section as a release checklist.

Current playable foundation: durable SpacetimeDB tables are the store, anonymous SpacetimeDB Identity gives each browser a persistent trogg, and optional SpacetimeAuth OIDC lets a guest claim an account with `startClaim`/`redeemClaim`, `rename`, `player_named`, and `posthog.identify()`. Identity is issued by the connection and reducers authorize by `ctx.sender`; it is never client-asserted.

Implemented world systems: a static shared `ZONES` registry, zone-scoped subscriptions, per-tile walkability, cardinal grid-locked WASD movement, boulder pushing, roaming Hogs, hold-shift-to-run, sprite avatars, chat bubbles/history, trogg recolouring, a small ghost-trogg cosmetic, `/spawn`, and `/reset`. Some of these have optional client-side flag gates for remote rollout or kill-switch use; missing PostHog flags fall back according to the code.

Likely next work areas include starting-zone onboarding, click-to-move pathfinding around obstacles, gathering and XP, inventory/equipment, crafting, communal projects, Hog merchants, load events, LLM-driven Hogs, and optional PvE defense. These are intentionally fluid; implement the slice that best serves the current task.
## Open design threads

- Mascot integration: a first programmer-pixel-art trogg/Hog sprite sheet has landed (`shared/sprites.ts` → `assets/sprites/`, rendered for troggs behind `avatar-sprites`); replacing it with finished concept-art-based sprites is the remaining work.
- Tilemap and pixel asset direction once the colored grid stops being charming.
- Light/darkness as a mechanic: torch radius, communal beacons, dark-gated zones — how literal to make it.
- Own-avatar prediction polish: basic optimistic acknowledgement handling has landed for movement; richer rollback/smoothing is deferred until playtests show a need.
- Currency design.
