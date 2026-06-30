import { initAnalytics } from "./analytics.js";

// Landing page boots PostHog so autocapture and session replay cover the
// funnel — landing pageview → play click → `player_joined` once the game
// connects on /play. No game bundle loads here.
initAnalytics();

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
