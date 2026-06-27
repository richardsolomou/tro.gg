# Analytics

The PostHog plan: every product gets a real job when it is useful. This document is binding alongside the [GDD](gdd.md) when adding or changing custom events, experiments, or feature flags.

## Product plan

| Product | In-game job |
| ------- | ----------- |
| Autocapture + events | Core telemetry from day one |
| Session replay | Watch new players get lost; review sessions after the fact; debugging; canvas recording enabled for the Phaser playfield |
| Identify / person profiles | Guest → account upgrade, merged identities |
| Funnels / retention | Onboarding funnel, XP progression, return cohorts |
| Feature flags | Remote rollout, kill-switches, balance knobs, and experiments when they are worth the extra branch |
| Experiments | A/B on tuning values (gather times, respawns), announced to players |
| Error tracking | Client + server errors |
| Surveys | In-game feedback prompts |
| AI observability | LLM-driven Hogs — traces, cost, quality |
| Logs | Structured client diagnostics tied to user/session context, plus trusted sidecar diagnostics |

## Events

snake_case. Low-volume by design — anything that could fire more than ~once/sec per player gets aggregated server-side first. Movement generates **zero** events.

| Event | Properties | Fires when |
| ----- | ---------- | ---------- |
| `player_joined` | `zone, is_guest` | Session starts and the trogg exists in the world |
| `connection_lost` | — | Live SpacetimeDB socket dropped after being connected (usually a backend redeploy); the client begins auto-reconnecting. Best-effort — fired just before the recovery reload, so it measures deploy disruption |
| `client_update_available` | — | Polling spotted a newer deployed frontend than the running build (a Cloudflare-only deploy); the refresh prompt is shown. Measures how many players are on a stale client after a frontend deploy |
| `account_claim_started` | — | Player starts the guest → account claim flow and is about to leave for SpacetimeAuth |
| `account_signed_out` | — | Signed-in player explicitly signs out from the account panel |
| `player_named` | — | Guest upgrades to an account — fires when a claim is redeemed, alongside `identify()` (the OIDC subject), merging the guest's history |
| `trogg_renamed` | `zone, source?` | Player's own name changes after the authoritative player row updates |
| `trogg_recolored` | `color, source?` | Player picks an avatar colour — `color` is the chosen `TROGG_COLORS` palette index |
| `trogg_restyled` | `style, source?` | Player picks an avatar body style — `style` is the chosen `TROGG_STYLES` id (e.g. `stone`) |
| `inventory_item_acquired` | `zone?, item, qty, source?` | Player's own inventory receives a new item row or stack increase from authoritative inventory sync |
| `item_equipped` | `zone, item, equipped, source?` | Player's own main-hand equipment changes; `equipped=false` means the item was unequipped |
| `equipped_item_used` | `zone, item, source?` | Player's own equipped item use is accepted and appears on the authoritative player row |
| `zone_entered` | `zone, from_zone` | Zone transition |
| `action_started` | `action, node_type, zone` | Action begins |
| `resource_gathered` | `node_type, item, zone` | Action completes |
| `xp_gained` | `skill, amount, level` | XP granted (batch if volume demands) |
| `level_up` | `skill, level` | Derived level increases |
| `chat_sent` | `zone, source?` | Message sent — **no content** |
| `boulders_reset` | `zone, source` | Player resets boulders via the in-chat `/reset` (or `/reset boulders`) command or Commands panel |
| `hedgehogs_reset` | `zone, source` | Player resets Hogs via the in-chat `/reset hedgehogs` command or Commands panel |
| `debug_entity_spawned` | `zone, kind, count, source` | Player requests `/spawn` or Commands panel spawn for a supported debug entity — `kind` is `boulder` or `hog`; the server may cap the inserted count |
| `ghost_summoned` | `zone, source, count` | Player requests one or more synced cosmetic ghost haunts via launch chance, `/ghost`, or the Commands panel |
| `object_picked_up` | `zone, kind, source?` | Player picks up a tile-sized object — `kind` is `boulder` or `hog` |
| `object_dropped` | `zone, kind, source?` | Player puts down what they were carrying |
| `item_crafted` | `recipe, qty` | Item crafting succeeds |
| `project_contributed` | `project, item, qty` | Player contributes to a communal project |
| `project_completed` | `project` | Communal project completes |
| `shop_purchase` | `item, qty, price` | Player buys from a Hog merchant |

Client events via posthog-js (plus autocapture + session replay). SpacetimeDB reducers are network-isolated — they can't call out to PostHog — so the browser emits immediate gameplay-authoritative events when it observes the authoritative table change that earns them. The trusted Node sidecar (`instrumentation/index.ts`) also uses `posthog-node` to poll the SpacetimeDB HTTP SQL API and emit backend-derived events from public table diffs with `source=spacetimedb-sidecar`. It uses HTTP SQL rather than an SDK subscription so the observer does not run `clientConnected` and create a visible trogg.

## Feature flags

Feature flags are optional operational controls. Use them for remote rollout, kill-switches, experiments, or live tuning. Do not add a flag just because a feature is new. If code reads a flag key, register it here with its fallback and create or update the matching flag in the configured PostHog project in the same task, at the intended rollout.

Code currently reads these flag keys:

| Flag | Controls | Fallback |
| ---- | -------- | -------- |
| `auth-enabled` | Account sign-in / claim panel (the top-right claim/sign-out control) | On, but the UI still requires `VITE_SPACETIMEAUTH_CLIENT_ID` |
| `avatar-sprites` | Trogg sprite avatars vs the placeholder colour marker | On |
| `ghost-trogg` | Zone-synced cosmetic ghost easter egg (launch haunt + `/ghost` command + Commands panel ghost buttons) | On |
| `boulder-pushing` | Client push input for boulders | On |
| `interact` | Interact key (`E`) — pick up / put down tile-sized objects | On |
| `roaming-hogs` | Hog rendering and subscription | On |
| `running` | Hold-shift-to-run input | On |
| `spawn-command` | `/spawn` debug command and Commands panel spawn controls | On outside production (local dev + preview builds, which ship no PostHog key); flag-governed in production |
| `boulder-reset` | `/reset` (or `/reset boulders`) boulder layout command and Commands panel reset control | On |
| `hog-reset` | `/reset hedgehogs` Hog population reset command and Commands panel reset control | On |
| `chat-enabled` | Chat panel and bubbles | On |
| `trogg-recolor` | Colour swatches in the Appearance panel | On |
| `trogg-restyle` | Body-style buttons in the Appearance panel | On |

PostHog project audit (2026-06-27): all code-read flags above are configured in PostHog project 314596 and active. They are intentionally still in use because they cover remote rollback, production-only debug command governance, or visible UI capabilities that should not advertise disabled controls. `interact` was created 2026-06-25 with the carry mechanic; `hog-reset` was created 2026-06-25 with the `/reset hedgehogs` command; `trogg-restyle` was created 2026-06-27 with avatar body styles. No new flag is needed for the observability pass; planned future flags should be added here, and created in PostHog, when code starts reading them.

## Error tracking and logs

The browser SDK initializes with exception autocapture for unhandled errors, unhandled promise rejections, and `console.error()` calls. Handled failures in startup, account claim/sign-in, silent auth refresh, and reducer-backed account, appearance, inventory, or command actions should go through `logError()` with stable `surface` / `action` context so they are visible in DevTools and captured by PostHog Logs without relying on console-log autocapture.

Structured browser logs go through explicit `logInfo()` / `logWarn()` / `logError()` helpers with `service.name = trogg-web`, the Vite build stamp as `service.version`, and the Vite mode as `deployment.environment`. Console-log autocapture is off to avoid double-capturing helper output. Use these helpers for startup, world boot flags, account actions, deploy recovery, version prompts, validation rejections, and debug command outcomes without chat content or arbitrary command text.

Backend logs and handled sidecar exceptions use the trusted Node sidecar. It sends PostHog Logs with `service.name = trogg-sidecar`, captures poll/runtime exceptions with `posthog-node`, and should run with `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST`, `SPACETIMEDB_HTTP_HOST`, and `SPACETIMEDB_DB_NAME`. Do not log raw player chat, arbitrary command text, credentials, OIDC tokens, or SpacetimeDB tokens.

Session Replay records the Phaser canvas via `session_recording.captureCanvas.recordCanvas = true`. The SDK's local canvas FPS option is capped at 12, so tro.gg sets `canvasFps = 12`; use lower values if replay payload size becomes a problem.

## Rules

- Events never contain chat content or PII beyond the player name.
- Experiments on tuning values are announced to the players in them (design pillar 3) — players are always told when they're in one.
