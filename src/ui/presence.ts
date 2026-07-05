import { derivedKindlingCharge, presenceState } from "@trogg/shared";
import type { DbConnection } from "../net/module_bindings";
import type { Player } from "../net/module_bindings/types";
import { hudRoot } from "./hud.js";

function nowStamp() {
  return { microsSinceUnixEpoch: BigInt(Date.now()) * 1000n };
}

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function mountPresence(conn: DbConnection, playerId: string): void {
  const panel = document.createElement("div");
  panel.className = "presence-status";
  hudRoot().appendChild(panel);

  let player: Player | undefined;
  const render = () => {
    if (!player) return;
    const now = nowStamp();
    const state = presenceState(player, now);
    const charge = derivedKindlingCharge(player, now);
    panel.dataset.state = state;
    panel.textContent = state === "bright"
      ? `Spark bright · ember reserve ${duration(charge)}`
      : state === "ember"
        ? `Spark ember · ${duration(charge)} remaining`
        : "Spark dormant · return to wake";
  };
  const mine = (row: Player) => row.identity.toHexString() === playerId;
  for (const row of conn.db.player.iter()) if (mine(row)) player = row;
  conn.db.player.onInsert((_ctx, row) => {
    if (!mine(row)) return;
    player = row;
    render();
  });
  conn.db.player.onUpdate((_ctx, _old, row) => {
    if (!mine(row)) return;
    player = row;
    render();
  });
  render();
  window.setInterval(render, 1_000);
}
