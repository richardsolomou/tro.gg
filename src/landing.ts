import { initAnalytics } from "./analytics.js";
import { mountBackdrop } from "./landing3d.js";
import { theme } from "./theme.js";

// Landing page boots PostHog so autocapture and session replay cover the
// funnel — landing pageview → play click → `player_joined` once the game
// connects on /play. The hero is an ambient low-poly cave backdrop
// (landing3d.ts) — the Three.js chunk it pulls is shared with /play, so it's
// warm in cache by the time the player steps in. No netcode loads here.
initAnalytics();

// The game theme starts here and swells in — walking into the world doesn't
// audibly restart it (the stream is generative; the fade is the continuity).
theme.start();

const backdrop = document.getElementById("diorama");
if (backdrop instanceof HTMLCanvasElement) mountBackdrop(backdrop);

const TWITCH_CHANNEL = "richardsolomou";

// Reveal the "live now" pill only while the Twitch channel is streaming. decapi.me is a
// keyless public uptime endpoint (CORS-open), so this needs no secret in the public bundle
// (invariant 8). It returns an uptime like "2 hours, 5 minutes" when live and "… is offline"
// otherwise; anything unexpected (or a network error) just leaves the pill hidden.
const livePill = document.getElementById("live");
const refreshLive = async () => {
  if (!(livePill instanceof HTMLElement)) return;
  try {
    const res = await fetch(`https://decapi.me/twitch/uptime/${TWITCH_CHANNEL}`, { cache: "no-store" });
    const text = (await res.text()).toLowerCase();
    livePill.hidden = !(res.ok && /\b(second|minute|hour|day)s?\b/.test(text));
  } catch {
    livePill.hidden = true;
  }
};
void refreshLive();
setInterval(() => void refreshLive(), 60_000);
