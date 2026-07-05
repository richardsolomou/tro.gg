# Analytics

The PostHog plan: every product gets a real job when it is useful. This document is binding alongside the [GDD](gdd.md) when adding or changing custom events, experiments, or feature flags.

## Product plan

| Product | In-game job |
| ------- | ----------- |
| Autocapture + events | Core telemetry from day one |
| Session replay | Watch new players get lost; review sessions after the fact; debugging; canvas recording enabled for the WebGL playfield |
| Identify / person profiles | Guest → account upgrade, merged identities |
| Funnels / retention | Onboarding funnel, XP progression, return cohorts |
| Feature flags | Remote rollout, kill-switches, balance knobs, and experiments when they are worth the extra branch |
| Experiments | A/B on tuning values (gather times, respawns), announced to players |
| Error tracking | Client + server errors |
| Surveys | In-game feedback prompts |
| AI observability | Open — the prior plan (LLM-driven Hog NPCs) was retired with the Hog-town design; no current use case, revisit if one emerges |
| Logs | Structured client diagnostics tied to user/session context |

## Events

snake_case. Low-volume by design — anything that could fire more than ~once/sec per player gets aggregated server-side first. Movement generates **zero** events.

| Event | Properties | Fires when |
| ----- | ---------- | ---------- |
| `player_joined` | `zone, is_guest` | Session starts and the trogg exists in the world |
| `connection_lost` | — | Live SpacetimeDB socket dropped after being connected (usually a backend redeploy); the client begins auto-reconnecting. Best-effort — fired just before the recovery reload, so it measures deploy disruption |
| `client_update_available` | — | Polling spotted a newer deployed frontend than the running build (a Cloudflare-only deploy); the refresh prompt is shown. Measures how many players are on a stale client after a frontend deploy |
| `account_claim_started` | — | Player starts the guest → account claim flow and is about to leave for SpacetimeAuth |
| `account_claim_failed` | `had_pending_claim` | The return from SpacetimeAuth failed — the provider came back with `?error=…` or the token exchange threw, so no account token was obtained. `had_pending_claim` is `true` when a guest was mid-claim (vs a fresh-device sign-in). Makes a broken claim/identify flow visible instead of looking like nobody tried |
| `account_signed_out` | — | Signed-in player explicitly signs out from the account panel |
| `player_named` | — | Guest upgrades to an account — fires when a claim is redeemed, alongside `identify()` (the OIDC subject), merging the guest's history |
| `trogg_renamed` | `zone, source?` | Player's own name changes after the authoritative player row updates |
| `trogg_recolored` | `color, source?` | Player picks an avatar colour — `color` is the chosen `TROGG_COLORS` palette index |
| `trogg_restyled` | `style, source?` | Player picks an avatar body style — `style` is the chosen `TROGG_STYLES` id (e.g. `stone`) |
| `inventory_item_acquired` | `zone?, item, qty, source?` | Player's own inventory receives a new item row or stack increase from authoritative inventory sync — now scoped to equipment and rare finds, since bulk raw resources deposit straight into the stockpile instead (see gdd.md "Inventory") |
| `item_equipped` | `zone, item, equipped, source?` | Player's own main-hand equipment changes; `equipped=false` means the item was unequipped |
| `equipped_item_used` | `zone, item, source?` | Player's own equipped item use is accepted and appears on the authoritative player row |
| `inventory_item_dropped` | `zone, item, source?` | Player drops one unit of an inventory item back into the world as a `ground_item` |
| `inventory_item_discarded` | `zone, item, source?` | Player permanently destroys one unit of an inventory item (no ground item created) |
| `zone_entered` | `zone, from_zone` | Zone transition |
| `action_started` | `action, node_type, zone` | Action begins |
| `resource_gathered` | `node_type, item, zone` | Action completes |
| `xp_gained` | `skill, amount, level` | XP granted (batch if volume demands) |
| `level_up` | `skill, level` | Derived level increases |
| `chat_sent` | `zone, source?` | Message sent — **no content** |
| `boulders_reset` | `zone, source` | Player resets boulders via the Commands panel |
| `dark_creatures_reset` | `zone, source` | Player resets dark creatures via the Commands panel (replaces the retired `hedgehogs_reset`) |
| `debug_entity_spawned` | `zone, kind, count, source, item?, style?` | Player requests a Commands panel spawn for a supported debug entity — `kind` is `boulder`, `tree`, `dark_creature`, or `item`; `style` is present for exact species spawns and `item` for spawned pickup items |
| `ghost_summoned` | `zone, source, count` | Player requests one or more synced cosmetic ghost haunts via the Commands panel |
| `object_picked_up` | `zone, kind, source?` | Player picks up a tile-sized object — `kind` is `ember_heart` (replaces the retired Hog carry; boulders stopped being carryable earlier still, so old events may carry `hog` or `boulder`) |
| `object_dropped` | `zone, kind, source?` | Player puts down what they were carrying |
| `object_thrown` | `zone, kind, range, source?, hit_target?` | Player throws what they carry; `hit_target` is `trogg` or `dark_creature` when the throw damages a character. Currently dormant — the one live carryable (an ember-heart) has no defined throw behaviour (see gdd.md "Combat") |
| `combat_hit` | `zone, weapon, target, damage, killed, source?` | An accepted server-side attack damages a trogg or dark creature. `weapon` is the main-hand item id (`sword`, `axe`, `pickaxe`, `shovel`), `fists`, or `thrown_boulder`; `target` is `trogg` or `dark_creature`. `damage` is the amount actually dealt after a shielded trogg's `SHIELD_BLOCK_FRACTION` reduction, not the raw weapon roll |
| `player_died` | `zone, cause, dropped_item_rows, dropped_item_qty, respawn_ms, source?` | Server-side combat damage kills a trogg, drops its inventory, and schedules its respawn |
| `player_respawned` | `zone, respawn_ms, source` | The local player's authoritative row transitions from dead to alive after the scheduled respawn timer |
| `warren_emerged` | Client, when a trogg's emergence from its cave lands it in the world (post-transfer boot) | `zone` |
| `item_crafted` | `recipe, qty` | Item crafting succeeds |
| `project_contributed` | `project, item, qty` | Player contributes to the stockpile toward a communal project — currently, an ignition site (see gdd.md "The fire and the dark") |
| `project_completed` | `project` | A communal project completes — for an ignition project, this is the moment a brazier lights |

New events anticipated by the fire-and-dark design (brazier ignition/gutter, a trogg going ember/dormant, kindling charge running out) are not yet locked down — the underlying reducers don't exist yet (see gdd.md Roadmap). Register them here in the same change that adds them, per the rule below.

Client lifecycle events use posthog-js (plus autocapture + session replay). Gameplay actions that need trusted server-side product events should use SpacetimeDB procedure wrappers rather than calling reducers directly from the browser. Each `*Action` procedure performs the authoritative mutation inside `ctx.withTx(...)`, derives event properties from server state, and then best-effort posts the accepted event to PostHog from the module with `source=spacetimedb-procedure` unless the caller supplies a narrower source such as `chat`, `commands`, `appearance`, `inventory`, or `keyboard`. Death from combat is captured by the attacking procedure as `player_died`; respawn is captured client-side from the local authoritative row transition because it is driven by a scheduled reducer, not a procedure call. Movement still generates zero events.

The procedure wrappers accept the existing public `VITE_POSTHOG_KEY` as an argument because SpacetimeDB modules do not have the browser's Vite env at runtime. The PostHog project key is already public in the client bundle; never pass private API keys, OIDC tokens, SpacetimeDB tokens, chat content, or arbitrary command text through procedure telemetry parameters.

## Feature flags

Feature flags are optional operational controls. Use them for remote rollout, kill-switches, experiments, or live tuning. Do not add a flag just because a feature is new. If code reads a flag key, register it here with its fallback and create or update the matching flag in the configured PostHog project in the same task, at the intended rollout.

Code currently reads these flag keys:

| Flag | Controls | Fallback |
| ---- | -------- | -------- |
| `auth-enabled` | Account sign-in / claim panel (the top-right claim/sign-out control) | On, but the UI still requires `VITE_SPACETIMEAUTH_CLIENT_ID` |
| `ghost-trogg` | Zone-synced cosmetic ghost easter egg (Commands panel ghost button) | On |
| `interact` | Interact key (`E`) — pick up ground items, pick up / put down tile-sized carryables | On |
| `running` | Hold-shift-to-run input | On |
| `spawn-command` | Commands drawer spawn controls | On outside production (local dev + preview builds, which ship no PostHog key); flag-governed in production |
| `cheat-commands` | Commands drawer cheats (speed, fly, noclip, god mode, heal, unstuck, sky lock) | On outside production, like `spawn-command`; flag-governed in production. Gates the UI only — `setCheats` stays a plain reducer (created 2026-07-03) |
| `boulder-reset` | Commands panel boulder layout reset control | On |
| `chat-enabled` | Chat panel and bubbles | On |
| `trogg-recolor` | Colour swatches in the Appearance panel | On |
| `trogg-restyle` | Body-style buttons in the Appearance panel | On |

Retired by the 3D renderer port: `avatar-sprites` (trogg sprite avatars vs the placeholder colour marker) is no longer read — the 3D client always renders models. The PostHog flag stays live while the 2D client is still the deployed production build; archive it in project 314596 when this port ships. Retired with boulder pushing: `boulder-pushing` is no longer read — boulders are mining nodes, not pushable; archive alongside `avatar-sprites`.

PostHog project audit (2026-07-05): all code-read flags above are configured in PostHog project 314596 and active. `roaming-hogs` and `hog-reset` are retired from code; archive them in project 314596 when authenticated PostHog access is available. Future dark-creature flags should be registered here and created in PostHog only when code starts reading them.

## Error tracking and logs

The browser SDK initializes with exception autocapture for unhandled errors, unhandled promise rejections, and `console.error()` calls. Handled failures in startup, account claim/sign-in, silent auth refresh, and reducer- or procedure-backed account, appearance, inventory, or command actions should go through `logError()` with stable `surface` / `action` context so they are visible in DevTools and captured by PostHog Logs without relying on console-log autocapture.

Structured browser logs go through explicit `logInfo()` / `logWarn()` / `logError()` helpers with `service.name = trogg-web`, the Vite build stamp as `service.version`, and the Vite mode as `deployment.environment`. Console-log autocapture is off to avoid double-capturing helper output. Use these helpers for startup, world boot flags, local death/respawn row transitions, account actions, deploy recovery, version prompts, validation rejections, and debug command outcomes without chat content or arbitrary command text.

The SpacetimeDB module currently captures accepted gameplay events from procedures, not general backend logs. Procedure telemetry failures are swallowed so analytics cannot roll back a committed gameplay action. Do not log or capture raw player chat, arbitrary command text, credentials, OIDC tokens, or SpacetimeDB tokens.

Session Replay records the game's WebGL canvas via `session_recording.captureCanvas.recordCanvas = true`. tro.gg sets `canvasFps = 15`; use lower values if replay payload size becomes a problem.

## Rules

- Events never contain chat content or PII beyond the player name.
- Experiments on tuning values are announced to the players in them (design pillar 3) — players are always told when they're in one.
