import { isFeatureEnabled } from "../analytics.js";
import { POSTHOG_KEY } from "../env.js";

/** Which Commands panel tools are live, each behind its own feature flag. */
export interface ChatCommandFlags {
  spawn: boolean;
  resetBoulders: boolean;
  resetDarkCreatures: boolean;
  ghost: boolean;
  cheats: boolean;
}

/** Resolve the live Commands panel flags once per mounted HUD surface. */
export function currentCommandFlags(): ChatCommandFlags {
  return {
    spawn: isFeatureEnabled("spawn-command", import.meta.env.DEV || !POSTHOG_KEY),
    resetBoulders: isFeatureEnabled("boulder-reset"),
    resetDarkCreatures: isFeatureEnabled("dark-creature-reset"),
    ghost: isFeatureEnabled("ghost-trogg"),
    cheats: isFeatureEnabled("cheat-commands", import.meta.env.DEV || !POSTHOG_KEY),
  };
}
