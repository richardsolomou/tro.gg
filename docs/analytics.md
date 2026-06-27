# Analytics

The PostHog plan: every product gets a real job when it is useful. This document is binding alongside the [GDD](gdd.md) when adding or changing custom events, experiments, or feature flags.

## Product plan

| Product | In-game job |
| ------- | ----------- |
| Autocapture + events | Core telemetry from day one |
| Session replay | Watch new players get lost; review sessions after the fact; debugging |
| Identify / person profiles | Guest → account upgrade, merged identities |
| Funnels / retention | Onboarding funnel, XP progression, return cohorts |
| Feature flags | Remote rollout, kill-switches, balance knobs, and experiments when they are worth the extra branch |
| Experiments | A/B on tuning values (gather times, respawns), announced to players |
| Error tracking | Client + server errors |
| Surveys | In-game feedback prompts |
| AI observability | LLM-driven Hogs — traces, cost, quality |

## Events

snake_case. Low-volume by design — anything that could fire more than ~once/sec per player gets aggregated server-side first. Movement generates **zero** events.

| Event | Properties | Fires when |
| ----- | ---------- | ---------- |
| `player_joined` | `zone, is_guest` | Session starts and the trogg exists in the world |
| `connection_lost` | — | Live SpacetimeDB socket dropped after being connected (usually a backend redeploy); the client begins auto-reconnecting. Best-effort — fired just before the recovery reload, so it measures deploy disruption |
| `client_update_available` | — | Polling spotted a newer deployed frontend than the running build (a Cloudflare-only deploy); the refresh prompt is shown. Measures how many players are on a stale client after a frontend deploy |
| `player_named` | — | Guest upgrades to an account — fires when a claim is redeemed, alongside `identify()` (the OIDC subject), merging the guest's history |
| `trogg_recolored` | `color` | Player picks an avatar colour — `color` is the chosen `TROGG_COLORS` palette index |
| `trogg_restyled` | `style` | Player picks an avatar body style — `style` is the chosen `TROGG_STYLES` id (e.g. `stone`) |
| `zone_entered` | `zone, from_zone` | Zone transition |
| `action_started` | `action, node_type, zone` | Action begins |
| `resource_gathered` | `node_type, item, zone` | Action completes |
| `xp_gained` | `skill, amount, level` | XP granted (batch if volume demands) |
| `level_up` | `skill, level` | Derived level increases |
| `chat_sent` | `zone` | Message sent — **no content** |
| `boulders_reset` | `zone` | Player resets boulders via the in-chat `/reset` (or `/reset boulders`) command or Commands panel |
| `hedgehogs_reset` | `zone` | Player resets Hogs via the in-chat `/reset hedgehogs` command or Commands panel |
| `object_picked_up` | `zone, kind` | Player picks up a tile-sized object — `kind` is `boulder` or `hog` |
| `object_dropped` | `zone, kind` | Player puts down what they were carrying |
| `item_crafted` | `recipe, qty` | Item crafting succeeds |
| `project_contributed` | `project, item, qty` | Player contributes to a communal project |
| `project_completed` | `project` | Communal project completes |
| `shop_purchase` | `item, qty, price` | Player buys from a Hog merchant |

Client events via posthog-js (plus autocapture + session replay). SpacetimeDB reducers are network-isolated — they can't call out to PostHog — so events fire client-side: the client emits a gameplay-authoritative event (`resource_gathered`, `xp_gained`, `level_up`, crafting, projects, purchases) when it observes the authoritative table change that earns it. If server-truth emission is ever needed, an external process subscribing to the tables can carry it; the event names and properties below are unchanged either way.

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

PostHog project audit (2026-06-27): all code-read flags above are configured in PostHog project 314596 and active at 100% rollout (`interact` created 2026-06-25 with the carry mechanic; `hog-reset` created 2026-06-25 with the `/reset hedgehogs` command; `trogg-restyle` created 2026-06-27 with avatar body styles). Planned future flags should be added here, and created in PostHog, when code starts reading them.

## Rules

- Events never contain chat content or PII beyond the player name.
- Experiments on tuning values are announced to the players in them (design pillar 3) — players are always told when they're in one.
