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
- **WASD / arrow keys:** hold to move in a direction, release to stop. Direct control — the trogg moves until you let go, hit a wall, or reach a zone edge.

Both are **input-driven, not per-frame.** The client writes a movement intent only on input transitions — a click (which sets a path), a key down/up, or a direction change — never on a timer or every frame. The server stores each player's motion as an origin `(x, y)`, a direction or a path, and `movedAt`; position over time is derived from these, and clients render it locally between updates.

- Move speed: 4 tiles/sec *(initial)*, shared by both modes. A click overrides held keys and vice versa.
- **Obstacles:** tiles carry a walkability flag; nodes and scenery (trees, rocks, walls) sit on unwalkable tiles. WASD clamps at the first unwalkable tile or the zone edge; click-to-move routes around them.
- **Pathfinding:** the server runs grid `A*` over the zone's walkable tiles on each click, stores the resulting `path` on the player, and clients animate along that synced path — no client-side recompute, so no determinism mismatch to manage. An obstacle-free zone degenerates to a straight line. The algorithm runs server-side in the room on each click — a small hand-rolled grid `A*` or a battle-tested JS lib (PathFinding.js, easystarjs).
- **No teleport-by-quit.** The stored `(x, y)` is the *origin* of the current move, never the destination. Position is only advanced by elapsed real time × speed along `path`, so clicking far away and quitting skips nothing — on return you're wherever the clock puts you (arrived only if enough time actually passed). A scheduled task may settle `(x, y)` to the path's end at `movedAt + traveltime`, but never before it.
- **Prediction (display only):** because clients sync *intents*, not positions, every client derives the same motion locally and animates other troggs continuously from their last known intent — no waiting on a server round-trip to see movement. The server stays authoritative (invariant 3); a client snaps to server truth on any mismatch. Continuous extrapolation is inherent to the intent model; rollback-style reconciliation for your own avatar is optional polish, added only if it's needed.

### Camera and rendering

- 3/4 top-down (RuneScape-2004 / Stardew view), pixel art tiles and sprites.
- Rendered with **PixiJS** (WebGL/WebGPU canvas) on a Vite + TypeScript client, nearest-neighbour scaled for crisp pixels. The client consumes Colyseus room state and draws it; all authority stays server-side (invariant 3).

### Avatars and equipment

- A trogg (and a Hog) is a **layered sprite**: a base body plus composable overlay layers, drawn per facing (down/up/left/right) and per animation frame (idle/walk). Troggs and Hogs share the rig, so equipment renders the same on either.
- **Held items** (torch, pick, axe, sword, shield) render as per-hand layers — a **main hand** and an **off hand**, so combinations like sword + shield work. Each hand has its own anchor point and z-order per direction/frame (e.g. the off-hand arm and its item sit behind the body when facing up, in front when facing down). A new holdable is a new item sprite, not a new character.
- **Armor (later)** layers the same way over body slots (head, torso). The rig reserves the layer order now; armor sprites are added with the mechanic.
- What's equipped rides the zone's player sync, so others see what you're holding. First held-item rendering lands with tools (M2); the model is built extensible from the first sprite.

### Zones

- A zone has a slug, display name, integer width/height in tiles, and a tilemap: per-tile walkability plus scenery. Nodes and obstacles sit on unwalkable tiles.
- **Zone definitions are a static code registry** (`ZONES` in `shared`, keyed by slug) — static design data like the item and node registries, not the durable `zones` table the data model lists. The table is deferred until tilemaps need editable storage; until then a zone is a registry entry. One room hosts one zone (joined by slug, `filterBy(["zone"])`); its dimensions ride the room state so the client renders from server truth, not a constant.
- **Spawn and the hub gate (M1):** new players spawn in a shared **starting zone** (working name: the cave) and must reach a checkpoint to unlock the hub, `hog-town`. The hub isn't available until the checkpoint is crossed — a per-player progression gate, not an instance; the starting zone is shared like any other.
- M0 ships a single shared zone to prove the loop *(working slug `hog-town`, 24×16 (initial))*; the starting zone and gate land with M1.
- Clients subscribe to players/nodes/chat **in their current zone only**. Within a zone, sync is deliberately naive (whole-zone queries) — see invariant 10.
- New zones ship incrementally; transitions are walk-to-edge or interact-with-passage. How later areas gate (checkpoints, light, communal projects) is an open thread.

### Chat

- Zone-scoped. Max 200 chars *(initial)*. Bubble displays 5s *(initial)*; side panel keeps recent history.
- Server-side rate limit: 1 message/sec per player *(initial)*.
- Message content is **never** sent to analytics.

### Identity

- Anonymous-first: on first load the server issues an anonymous credential (a signed token the browser stores) and Colyseus validates it in `onAuth`. Guests get a generated name: `trogg-####` and exist within seconds, no signup.
- **Guest persistence:** the browser securely stores the guest's auth credential — not game state, which stays server-authoritative (invariant 3) — so a returning visitor resumes the same trogg with their progress intact. Clearing the browser or switching devices makes a guest a new trogg.
- **Signing in** upgrades a guest to an account: pick a real name (fires `player_named` and `posthog.identify()`, merging the guest's history) and play cross-browser/device, since the account — not the browser — now anchors the synced state.
- Names: unique, 3–20 chars, alphanumeric + hyphen.

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

Two layers. **Postgres** is the durable store (tables below); **Redis** is a write-through cache in front of it. The **live room state** synced to clients is a `@colyseus/schema` projection of it — one room per zone holds the players in that zone (motion fields + equipment), its nodes (type, state, `respawnAt`), and recent chat; Colyseus syncs that schema to everyone in the room automatically. A room hydrates each player on join (Redis cache → Postgres → new) and writes durable changes back — to Redis on every change, flushed through to Postgres on leave, dispose, and a periodic checkpoint. An empty zone has no room (`autoDispose`) and rehydrates on the next join. Only settled position persists; transient motion intents (direction, path, `movedAt`) are not durable. Indexes noted where the access pattern demands them.

Both backends are optional in dev: without `DATABASE_URL` / `REDIS_URL` the missing layer is skipped and state is in-memory only. `docker compose up` provides local Postgres + Redis matching prod.

```text
players        userId, name, isGuest, zoneId, x, y, dirX, dirY, path, movedAt, hubUnlocked, equipment
               motion derived from origin (x,y) + movedAt: WASD uses dirX/dirY (0,0 = idle);
               click-to-move walks `path` (waypoint tiles, empty otherwise). hubUnlocked: M1 checkpoint gate.
               equipment: slot → item map, multiple slots at once (e.g. { mainHand: "sword", offHand: "shield" }; armor slots later) — rides the room's zone sync so others see it
               index: by_zone (zoneId)
zones          slug, name, width, height, tilemap (per-tile walkability + scenery), checkpoint (unlock tile, null if none)
               index: by_slug (slug)
               deferred — zone definitions currently live in a static code registry (ZONES in shared); this table lands when tilemaps need editable storage
nodes          type, zoneId, x, y, state ("available" | "depleted"), respawnAt
               index: by_zone (zoneId)
actions        playerId, nodeId, kind, startedAt, endsAt
               index: by_player (playerId)
chatMessages   zoneId, playerId, text, createdAt
               index: by_zone_recent (zoneId, createdAt)
skills         playerId, skill, xp
               index: by_player (playerId)
inventories    playerId, item, qty
               index: by_player (playerId)
projects       slug, zoneId, status, requirements, contributed     (M3)
               index: by_zone (zoneId)
```

## Multiplayer scaling stance

- **One room per zone, naive within it.** A zone maps to a Colyseus room; clients join the room for their current zone and Colyseus syncs its state to everyone in it. Within a room there's no interest management and no instancing — everyone sees every player.
- **Fixed cost, watched in metrics.** The VPS is a flat monthly bill, not a usage meter, so the concern is CPU, memory, and bandwidth per node — watched via server metrics and PostHog, not an egress invoice. At the realistic scale (tens of concurrent) a single process on a small Hetzner box is ample.
- **Capacity cap before launch.** Room and connection limits are set so a viral night sheds or queues load instead of toppling the box; vertical scale (a bigger VPS) is the first lever, horizontal (more processes) the second.
- **The answer key, only when a graph demands it:** raise the room's patch-rate budget, area-of-interest filtering via schema views (`@filter`), crowd aggregation above a density threshold, multiple processes sharing a Redis presence/driver, and — break-glass — moving the live position feed to a Redis pub/sub channel while the room keeps all authoritative state. None of these are built in advance.
- **Redis is already wired single-node** as the Colyseus presence/driver (and the player cache), so the prod backend is mirrored from M0. This is parity plumbing, not scale-out: still one process, rooms not distributed. Actually *running* multiple processes — and everything else in the answer key — stays deferred under invariant 10.
- **Swappable position feed:** the client consumes positions through one interface (`subscribeToPositions(area)`) and writes through one path. This is code hygiene, not optimization — it's what makes every option above a one-module swap.

## Invariants (non-negotiable)

1. No simulation tick. We never run a server simulation loop (no `setSimulationInterval`); state changes only on player input or scheduled completions (`clock.setTimeout`). Colyseus's patch loop merely *broadcasts* state diffs — an unchanged room produces none — and a zone with no players has no room (`autoDispose`), so an empty world computes nothing.
2. No per-frame or per-tile server sync. The server syncs movement intents (click→path, key down/up, direction change) via room messages; clients derive and predict motion locally. Synced player state changes on input, never on a timer or every frame.
3. All authoritative state lives on the server — the Colyseus room in memory, durably persisted to Postgres. Never trust the client.
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
| M0 | in progress | Tiny shared world | Avatars, click-to-move + WASD, chat bubbles, one zone | Colyseus room state sync, presence; autocapture, first session replays |
| M1 | not started | Identity & onboarding | Browser-persisted guests + cross-device sign-in, names; starting cave → checkpoint → hub gate; obstacles + A* pathfinding | Anonymous-first auth (self-issued tokens); `identify`, person profiles, unified front/back journeys |
| M2 | not started | Gathering loop | Stone + glowcap nodes, mining/foraging XP, leaderboard | Room timers + timestamp-derived respawns; funnels, retention |
| M3 | not started | Crafting & the tribe builds | Recipes, tools, first communal project, Hog merchants | Atomic Postgres transactions; flags as balance knobs, first A/B experiment |
| M4 | not started | The Great Delving | Community stress-test event: everyone piles in at once | Load behavior; live analytics at peak; the load graph's big night |
| M5 | not started | Talking Hogs | LLM-driven Hog NPCs | Actions calling LLMs; AI observability |
| M6 | not started | Defense events (optional) | PvE waves; protect the Hogs | Event-based combat within invariant 7 |

Durable persistence (Postgres + Redis cache + Colyseus presence/driver) landed in M0, ahead of the tracker, at maintainer direction — players now resume their trogg across reconnects and restarts. It rides a minimal browser-stored guest id (a `localStorage` UUID sent on join); M1 still owns the full identity story (signed credential validated in `onAuth`, cross-device sign-in, names).

Zones are now a first-class concept (M0 foundation): a static `ZONES` registry in `shared`, a `ZoneRoom` parameterized by slug (joined via `filterBy(["zone"])`), and dimensions synced on the room state so the client renders any zone without a hardcoded constant. M0 still runs one zone (`hog-town`); the registry and per-zone room routing make M1's starting cave, hub gate, and transitions a config-and-content change, not a refactor.

Zone chat (M0 scope) ships on top of it: speech bubbles over heads plus a history side panel, behind the `chat-enabled` flag. Recent lines persist to Postgres and replay when a zone's room respawns. Server-side validation enforces the 200-char cap and 1 msg/sec rate limit; the flag currently gates the client mount (server-side enforcement lands with posthog-node).

## Open design threads

- Mascot integration: the trogg concept art as the avatar spritesheet base.
- Tilemap and pixel asset direction once the colored grid stops being charming.
- Light/darkness as a mechanic: torch radius, communal beacons, dark-gated zones — how literal to make it (M2–M3 decision).
- Own-avatar prediction polish: rollback/reconciliation, only if intent-extrapolation alone feels laggy.
- Currency design at M3.
