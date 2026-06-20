# Analytics

The PostHog plan: every product gets a real job, introduced one milestone at a time. This document is binding alongside the [GDD](gdd.md) — new mechanics must register their events and flags here in the same change.

## Product plan

| Product | In-game job |
| ------- | ----------- |
| Autocapture + events | Core telemetry from day one |
| Session replay | Watch new players get lost; review sessions after the fact; debugging |
| Identify / person profiles | Guest → account upgrade, merged identities |
| Funnels / retention | Onboarding funnel, XP progression, return cohorts |
| Feature flags | Every mechanic ships behind one; balance knobs; gradual rollouts |
| Experiments | A/B on tuning values (gather times, respawns), announced to players |
| Error tracking | Client + server errors |
| Surveys | In-game feedback prompts |
| AI observability | M5 talking Hogs — traces, cost, quality |

## Events

snake_case. Low-volume by design — anything that could fire more than ~once/sec per player gets aggregated server-side first. Movement generates **zero** events.

| Event | Properties | Fires when |
| ----- | ---------- | ---------- |
| `player_joined` | `zone, is_guest` | Session starts and the trogg exists in the world |
| `player_named` | — | Guest upgrades to an account (alongside `identify()`) |
| `zone_entered` | `zone, from_zone` | Zone transition |
| `action_started` | `action, node_type, zone` | Action begins |
| `resource_gathered` | `node_type, item, zone` | Action completes |
| `xp_gained` | `skill, amount, level` | XP granted (batch if volume demands) |
| `level_up` | `skill, level` | Derived level increases |
| `chat_sent` | `zone` | Message sent — **no content** |
| `item_crafted` | `recipe, qty` | M3 |
| `project_contributed` | `project, item, qty` | M3 |
| `project_completed` | `project` | M3 |
| `shop_purchase` | `item, qty, price` | M3 |

Client events via posthog-js (plus autocapture + session replay). Server events via posthog-node in the game server — gameplay-authoritative events (`resource_gathered`, `xp_gained`, `level_up`, crafting, projects, purchases) fire server-side, not client-side.

## Feature flags

kebab-case. Every new mechanic ships behind a flag. Registry:

| Flag | Controls |
| ---- | -------- |
| `gathering-enabled` | M2 gathering system |
| `node-respawn-seconds` | Respawn tuning (multivariate / payload) |
| `crafting-enabled` | M3 crafting |
| `shop-enabled` | M3 Hog merchants |

## Rules

- Events never contain chat content or PII beyond the player name.
- Experiments on tuning values are announced to the players in them (design pillar 3) — players are always told when they're in one.
