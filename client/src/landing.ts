import { initAnalytics } from "./analytics.js";

// Landing page boots PostHog so autocapture and session replay cover the
// funnel — landing pageview → play click → `player_joined` once the game
// connects on /play. No game bundle loads here.
initAnalytics();
