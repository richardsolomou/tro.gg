# tro.gg — Game Design Document

The buildable spec for tro.gg. If you are an agent working on this codebase: this file is the source of truth for game rules, data, naming, and scope, together with [analytics.md](analytics.md) (events and flags) and [world.md](world.md) (setting, tone, and naming for UI copy). [challenge.md](challenge.md) is human-facing background; you rarely need it. When code and this document disagree, flag the conflict — don't silently pick one.

## How to use this document

- **Glossary names are canonical.** Use them in code, schema, events, and UI. Don't invent synonyms (it's a `node`, not a "resource spawner").
- **Constants marked *(initial)* are tuning values**, expected to change via feature flags — implement them as flag-readable, don't hardcode beliefs about them elsewhere.
- **The invariants section is non-negotiable.** If a task seems to require breaking one, stop and ask.
- **The milestone tracker reflects current state.** Don't build ahead of the current milestone unless asked.
- **New events and flags are registered in [analytics.md](analytics.md)** in the same change that introduces them.

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

**Onboarding (M1):** new players spawn in the shared starting zone (working name: the cave) and navigate to a checkpoint, which unlocks the hub (`hog-town`). It teaches movement and the world before the full loop opens (gathering layers on at M2). The specific framing is deferred (see [world.md](world.md)).

## Systems

### Movement

Two input modes, both supported:

- **Click-to-move:** click a tile → the trogg walks a pathfound route to it. Click a node or obstacle → route to the nearest reachable tile beside it (get as close as possible), then act.
- **WASD / arrow keys:** hold to move in a direction, release to stop. Direct control — the trogg moves until you let go, hit a wall, or reach a zone edge. **4-directional (cardinal only):** up, down, left, right — no diagonals, like classic top-down games (Pokémon, Zelda). Holding two perpendicular keys is resolved last-key-wins (the newest held key steers; releasing it resumes the other), so the intent is always one cardinal axis. The server rejects any diagonal intent rather than coercing it (invariant 3).

Both are **input-driven, not per-frame.** The client writes a movement intent only on input transitions — a click (which sets a path), a key down/up, or a direction change — never on a timer or every frame. The server stores each player's motion as an origin `(x, y)`, a direction or a path, and `movedAt`; position over time is derived from these, and clients render it locally between updates.

- Move speed: 4 tiles/sec *(initial)*, shared by both modes. A click overrides held keys and vice versa.
- **Obstacles:** tiles carry a walkability flag; nodes and scenery (trees, rocks, walls) sit on unwalkable tiles. WASD clamps at the first unwalkable tile or the zone edge; click-to-move routes around them.
- **Pathfinding:** the server runs grid `A*` over the zone's walkable tiles on each click, stores the resulting `path` on the player, and clients animate along that synced path — no client-side recompute, so no determinism mismatch to manage. An obstacle-free zone degenerates to a straight line. The algorithm runs server-side in the room on each click — a small hand-rolled grid `A*` or a battle-tested JS lib (PathFinding.js, easystarjs).
- **No teleport-by-quit.** The stored `(x, y)` is the *origin* of the current move, never the destination. Position is only advanced by elapsed real time × speed along `path`, so clicking far away and quitting skips nothing — on return you're wherever the clock puts you (arrived only if enough time actually passed). A scheduled task may settle `(x, y)` to the path's end at `movedAt + traveltime`, but never before it.
- **Prediction (display only):** because clients sync *intents*, not positions, every client derives the same motion locally and animates other troggs continuously from their last known intent — no waiting on a server round-trip to see movement. The server stays authoritative (invariant 3); a client snaps to server truth on any mismatch. Continuous extrapolation is inherent to the intent model; rollback-style reconciliation for your own avatar is optional polish, added only if it's needed.

### Pushing

Boulders are pushable rocks — dynamic obstacles, the same block-pushing grammar as classic top-down games. Walkability is the static tilemap **minus** the tiles boulders occupy, so the very collision that stops a trogg at a wall stops it flush at a boulder.

- A trogg pushes the boulder it walks squarely into: it must be **tile-aligned and flush**, facing the boulder along its cardinal direction. Lined up and walking in, the boulder slides one tile — if the tile beyond is open floor (no wall, no other boulder).
- **No tick** (invariant 1) and **server-authoritative** (invariant 3). The client detects, from its own prediction, the moment its avatar lines up against a boulder (a motion transition — never per frame, invariant 2) and calls the `push` reducer. The server re-derives the trogg's position from its stored intent, validates alignment + a clear destination, moves the boulder one tile, and re-bases the trogg's motion to the flush tile.
- **Cadence falls out of walk speed.** Re-basing leaves the boulder one tile ahead of the trogg, so it isn't faced again until the trogg physically catches up — the boulder advances at most one tile per tile walked, and spamming `push` can't make it move faster.
- Boulders start from the zone's `boulders` registry entry, seeded into the `boulder` table on first connect, then moved only by `push`. Behind the `boulder-pushing` flag (invariant 5): off → immovable rocks; on → pushable. Playable either way (invariant 6).
- **Resetting:** the in-chat `/reset` command snaps the player's current zone back to its registry boulder layout (the `resetBoulders` reducer clears and reseeds the zone). Behind the `boulder-reset` flag — off, `/reset` is just an ordinary chat line.

### Camera and rendering

- 3/4 top-down (RuneScape-2004 / Stardew view), pixel art tiles and sprites.
- Rendered with **PixiJS** (WebGL/WebGPU canvas) on a Vite + TypeScript client, nearest-neighbour scaled for crisp pixels. The client subscribes to the zone's SpacetimeDB tables and draws them; all authority stays server-side (invariant 3).

### Avatars and equipment

- A trogg (and a Hog) is a **layered sprite**: a base body plus composable overlay layers, drawn per facing (down/up/left/right) and per animation frame (idle/walk). Troggs and Hogs share the rig, so equipment renders the same on either.
- **Held items** (torch, pick, axe, sword, shield) render as per-hand layers — a **main hand** and an **off hand**, so combinations like sword + shield work. Each hand has its own anchor point and z-order per direction/frame (e.g. the off-hand arm and its item sit behind the body when facing up, in front when facing down). A new holdable is a new item sprite, not a new character.
- **Armor (later)** layers the same way over body slots (head, torso). The rig reserves the layer order now; armor sprites are added with the mechanic.
- What's equipped rides the zone's player sync, so others see what you're holding. First held-item rendering lands with tools (M2); the model is built extensible from the first sprite.
- **Sprite avatars (behind `avatar-sprites`):** a trogg renders as the layered avatar sprite — programmer pixel art generated from `shared/sprites.ts` (4 facings × idle/walk, troggs and Hogs sharing one rig), feet anchored on the tile. The stable per-trogg colour now rides as a sprite **tint** (a deterministic projection of its durable id — derived, never stored, like a level from XP), so the same trogg is the same colour for everyone, every session; your own trogg gets a ground ring so you can pick it out. The committed sprite sheet asset (`assets/sprites/`) is the reviewable export; the client paints the same art into a texture at runtime.
- **Placeholder marker (kill-switch fallback):** with `avatar-sprites` off, a trogg draws as a solid tile-filling marker in its stable colour (own trogg outlined) — the original placeholder, kept as the flag's fallback.

### Zones

- A zone has a slug, display name, integer width/height in tiles, and a tilemap: per-tile walkability plus scenery. Nodes and obstacles sit on unwalkable tiles.
- **Zone definitions are a static code registry** (`ZONES` in `shared`, keyed by slug) — static design data like the item and node registries, not the durable `zones` table the data model lists. The table is deferred until tilemaps need editable storage; until then a zone is a registry entry. A client subscribes to one zone's rows by slug (`WHERE zone_id = …`); zone dimensions and the per-tile walkability tilemap (`tiles`, read through `isWalkable`) come from the shared `ZONES` registry (imported by both the client and the module), so the grid is shared design data, not a per-session value. The client renders walls from the same tilemap it collides against, so what's drawn is what blocks you.
- **Spawn and the hub gate (M1):** new players spawn in a shared **starting zone** (working name: the cave) and must reach a checkpoint to unlock the hub, `hog-town`. The hub isn't available until the checkpoint is crossed — a per-player progression gate, not an instance; the starting zone is shared like any other.
- M0 ships a single shared zone to prove the loop *(working slug `hog-town`, 24×16 (initial))*; the starting zone and gate land with M1.
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
- First skills (M2): **mining** and **foraging**. Crafting skill arrives with M3. No combat skills until defense events are specced.

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

### Crafting (M3 — specced at M3)

- Recipes: inputs → output, optional skill/level requirement, crafted at stations in the Hog town (e.g., torches, better picks).
- Better tools gather faster or unlock harder node types — the progression spine.

### Communal construction (M3 — specced at M3)

- Projects the whole tribe contributes resources to ("the beacon needs 500 stone"), with a public progress bar. Completion unlocks a zone, station, or capability for everyone.
- Contributions are per-player tracked (leaderboards, achievements); the unlock is shared.

### Hog merchants and economy (M3 — specced at M3)

- Hog NPCs buy and sell at fixed prices in town. Player trading, if added, is a transactional mutation under contention — both inventories checked and mutated atomically.
- Currency: TBD at M3 (working name: shards).

### Defense events (post-M5 — specced if reached)

- PvE only. Things come out of the dark; the tribe defends the Hogs. Event-based combat: scheduled waves, slow stat-driven resolution, click-to-engage. No projectiles, no physics, no real-time aiming — ever (invariant 7).

### AI inhabitants (M5 — specced when M4 is done)

- LLM-driven Hog NPCs with real dialogue (merchants, quest-giver-ish townsfolk). Every interaction is an LLM call traced with AI observability.

## Data model

One layer. **SpacetimeDB** is the durable store *and* the live feed: the tables below are the source of truth, and clients subscribe directly to the rows in their current zone — there is no separate cache or room projection to keep in sync. Only **reducers** (transactional server functions) may write, and the writer's identity is the connection's own `ctx.sender` (invariant 3). A connecting client upserts its `player` row (`clientConnected`) and settles it on disconnect (`clientDisconnected`); SpacetimeDB persists every table, so a returning Identity resumes its trogg with no hydrate step. Motion intents (direction, `movedAt`) live in the durable row, but position is still *derived* from them with `projectMotion`, never advanced on a timer — the no-teleport-by-quit rule holds (invariant 1). A zone with no connected players produces no diffs and no work. Indexes noted where the access pattern demands them.

Dev mirrors prod: a local `spacetime start` instance runs the very module production runs — `just dev` publishes to it and regenerates the client bindings — so persistence is exercised the same way it runs in production. No Docker, no separate database to provision.

```text
player         identity (PK), name, isGuest, zoneId, x, y, dirX, dirY, movedAt, online, lastChatAt, hubUnlocked, equipment
               keyed by the connection's Identity. motion derived from origin (x,y) + movedAt: WASD uses
               dirX/dirY (0,0 = idle); click-to-move adds `path` (waypoint tiles) at M1. online: in-zone
               presence — clients subscribe to online players, so a disconnect settles the row and drops it
               from view without losing progress. lastChatAt: per-player chat rate limit. hubUnlocked: M1
               checkpoint gate. equipment: slot → item map, multiple slots at once (e.g. { mainHand: "sword",
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
hog            id (PK, auto-inc), zoneId, x, y     (tile coords)
               a static Hog NPC (GDD glossary). A debug affordance ahead of its M3 home: dropped by the
               `/spawn` command so the existing Hog sprite renders. Non-colliding, no movement or AI yet.
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
inventories    playerId, item, qty
               index: by_player (playerId)
projects       slug, zoneId, status, requirements, contributed     (M3)
               index: by_zone (zoneId)
```

## Multiplayer scaling stance

- **One subscription per zone, naive within it.** A client subscribes to the rows of its current zone; SpacetimeDB pushes row diffs to everyone subscribed. Within a zone there's no interest management and no instancing — everyone sees every player.
- **Fixed cost, watched in metrics.** The VPS runs the self-hosted SpacetimeDB instance on a flat monthly bill, not a usage meter, so the concern is CPU, memory, and bandwidth — watched via server metrics and PostHog, not an egress invoice. At the realistic scale (tens of concurrent) a single instance on a small Hetzner box is ample.
- **Capacity cap before launch.** Connection and subscription limits are set so a viral night sheds or queues load instead of toppling the box; vertical scale (a bigger VPS) is the first lever.
- **The answer key, only when a graph demands it:** narrow the subscription with area-of-interest SQL filters (a smaller `WHERE` per client), crowd aggregation above a density threshold, and — when one box isn't enough — SpacetimeDB's own horizontal scaling. None of these are built in advance.
- **Same module, dev to prod.** The instance the VPS runs is the module that runs locally, mirrored from M0. Running beyond a single instance — and everything else in the answer key — stays deferred under invariant 10.
- **Swappable position feed:** the client reads positions through the zone subscription and writes through reducers, both in one place. Tightening to area-of-interest is a query change, not a rewrite.

## Invariants (non-negotiable)

1. No simulation tick. We never run a server simulation loop; state changes only inside a reducer — on player input or a scheduled reducer (SpacetimeDB's deterministic timer, used for respawns and action completions). SpacetimeDB sends only row diffs to subscribers, so an unchanged table produces none and a zone with no connected players computes nothing.
2. No per-frame or per-tile server sync. Movement intents (click→path, key down/up, direction change) are sent via reducers; clients derive and predict motion locally. Synced player state changes on input, never on a timer or every frame.
3. All authoritative state lives on the server — SpacetimeDB's durable tables, written only by reducers, with the writer identified by `ctx.sender`. Never trust the client.
4. Analytics events are low-volume and never contain chat content or PII beyond the player name (full rules in [analytics.md](analytics.md)).
5. Every new mechanic ships behind a feature flag.
6. The game is playable at the end of every session. No half-wired states on `main`.
7. No PvP. No twitch combat: any PvE is event-based, stat-driven, and slow — no projectiles, physics, or real-time aiming. No procedural generation.
8. No secrets in the repo — env vars only, `.env*` is gitignored. This repo is public.
9. Glossary names are canonical across code, schema, events, and UI.
10. No preemptive scaling work. Optimizations from the scaling answer key are built only when a dashboard graph justifies them. No instancing below ~1,000 concurrent in a zone.

## Milestone tracker

Current milestone: **M0**. Don't build ahead without being asked.

| # | Status | Name | Scope | Demos |
| - | ------ | ---- | ----- | ----- |
| M0 | in progress | Tiny shared world | Avatars, click-to-move + WASD, chat bubbles, one zone | SpacetimeDB table subscriptions, presence; autocapture, first session replays |
| M1 | not started | Identity & onboarding | Browser-persisted guests + cross-device sign-in, names; starting cave → checkpoint → hub gate; obstacles + A* pathfinding | Anonymous-first auth (SpacetimeDB Identity); `identify`, person profiles, unified front/back journeys |
| M2 | not started | Gathering loop | Stone + glowcap nodes, mining/foraging XP, leaderboard | Scheduled reducers + timestamp-derived respawns; funnels, retention |
| M3 | not started | Crafting & the tribe builds | Recipes, tools, first communal project, Hog merchants | Atomic reducer transactions; flags as balance knobs, first A/B experiment |
| M4 | not started | The Great Delving | Community stress-test event: everyone piles in at once | Load behavior; live analytics at peak; the load graph's big night |
| M5 | not started | Talking Hogs | LLM-driven Hog NPCs | Actions calling LLMs; AI observability |
| M6 | not started | Defense events (optional) | PvE waves; protect the Hogs | Event-based combat within invariant 7 |

Durable persistence landed in M0, ahead of the tracker, at maintainer direction — SpacetimeDB's tables are the durable store, so players resume their trogg across reconnects and restarts with no separate cache or database. Anonymous identity landed alongside it, also ahead of the tracker: SpacetimeDB issues each connection a cryptographic Identity, the browser stores the connection token, and reducers authorise by `ctx.sender` — identity is connection-issued, never client-asserted (invariant 3).

The account-upgrade slice of M1 identity then landed too, also ahead of the tracker at maintainer direction: cross-device sign-in via **SpacetimeAuth** OIDC (Discord), the guest → account **claim** (a nonce minted by the guest and redeemed as the account — `startClaim`/`redeemClaim`, backed by the private `claim_code` table), and **renaming** (`rename`) with the `player_named` + `posthog.identify()` upgrade event. The browser-side OIDC flow is Authorization-Code-+-PKCE (a public client, no secret — invariant 8), all behind the `auth-enabled` flag (invariant 5). The earlier design note of a "recovery passphrase" was superseded by OIDC.

Zones are now a first-class concept (M0 foundation): a static `ZONES` registry in `shared`, imported by both the client and the module, with per-zone subscriptions keyed by slug (`WHERE zone_id = …`) so the client renders any zone from shared design data. M0 still runs one zone (`hog-town`); the registry and zone-scoped subscriptions make M1's starting cave, hub gate, and transitions a config-and-content change, not a refactor.

Per-tile walkability landed in M0, ahead of the tracker, at maintainer direction: zones carry a `tiles` tilemap, and WASD movement clamps at the first unwalkable tile or the zone edge — confined to the floor, like classic top-down games. WASD is also 4-directional (cardinal only, no diagonals; last-key-wins). The trogg is a 1×1 footprint and the same tilemap drives both collision and the rendered walls. What remains of M1's "obstacles + A* pathfinding" is the pathfinding half: click-to-move and server-side A* that routes *around* obstacles (WASD only stops *at* them).

Boulder pushing landed in M0 too, also at maintainer direction (see [Pushing](#pushing)) — pushable boulders as dynamic obstacles, shoved one tile at a time, behind the `boulder-pushing` flag. It reuses the walkability collision (a boulder is just an occupied tile) and the intent model (the push re-bases motion; cadence is walk speed, no tick), so it's an extension of movement rather than new infrastructure.

A cosmetic easter egg rides on M0 too: on join, a pale "ghost trogg" sometimes flickers in at the origin tile, then blinks to random tiles around the zone for a heartbeat each before fading, behind the `ghost-trogg` flag (invariant 5). It's a client-only render — no table, no reducer (invariant 3) — pure flavor seen only by the haunted player, not a mechanic with rules or data.

Zone chat (M0 scope) ships on top of it: speech bubbles over heads plus a history side panel, behind the `chat-enabled` flag. Recent lines live in the `chat_message` table and replay when a client subscribes. The `chat` reducer enforces the 200-char cap and 1 msg/sec rate limit server-side (invariant 3); the flag gates the client mount.

A `/spawn` debug command landed alongside chat, behind the `spawn-command` flag (default on in local dev, off in a production build): typing `/spawn boulder` or `/spawn hedgehog` in the chat box drops that entity at the caller's tile (the tile it faces, else a free neighbour). The placement and the `spawn` reducer are server-authoritative (invariant 3). This introduced the static `hog` table ahead of its M3 home so the existing Hog sprite has something to render — a non-colliding placeholder NPC, no movement or AI. There's no role system in M0, so the flag is the only gate; default it off in production.

## Open design threads

- Mascot integration: a first programmer-pixel-art trogg/Hog sprite sheet has landed (`shared/sprites.ts` → `assets/sprites/`, rendered for troggs behind `avatar-sprites`); replacing it with finished concept-art-based sprites is the remaining work.
- Tilemap and pixel asset direction once the colored grid stops being charming.
- Light/darkness as a mechanic: torch radius, communal beacons, dark-gated zones — how literal to make it (M2–M3 decision).
- Own-avatar prediction polish: rollback/reconciliation, only if intent-extrapolation alone feels laggy.
- Currency design at M3.
