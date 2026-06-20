import { Room, type Client } from "colyseus";
import { ClientMessage, type MovePayload, Player, projectMotion, STARTING_ZONE, ZoneState } from "@trogg/shared";

/**
 * One room per zone (GDD "Multiplayer scaling stance"). Skeleton scope: presence
 * plus WASD movement — a player is added on join, removed on leave, and reports
 * direction intents that the room settles into authoritative motion. Colyseus
 * diffs the state to everyone in the room. No simulation loop (invariant 1):
 * position is derived from the stored intent, never advanced on a timer. Chat,
 * nodes, click-to-move, and Postgres hydration land with their mechanics.
 */
export class ZoneRoom extends Room<{ state: ZoneState }> {
  onCreate() {
    this.state = new ZoneState();
    this.state.slug = STARTING_ZONE.slug;

    this.onMessage(ClientMessage.Move, (client, message: MovePayload) => this.onMove(client, message));
  }

  /**
   * A WASD direction intent. Settle the player's origin to where they are *now*
   * (so elapsed travel under the old direction isn't lost or replayed), then
   * store the new direction and timestamp. Position between intents is derived,
   * not ticked (invariant 1).
   */
  private onMove(client: Client, message: MovePayload) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const dirX = unitStep(message?.dirX);
    const dirY = unitStep(message?.dirY);

    const now = this.clock.currentTime;
    const settled = projectMotion(player, now - player.movedAt, STARTING_ZONE);
    player.x = settled.x;
    player.y = settled.y;
    player.dirX = dirX;
    player.dirY = dirY;
    player.movedAt = now;
  }

  onJoin(client: Client) {
    const player = new Player();
    player.name = `trogg-${client.sessionId.slice(0, 4)}`;
    player.x = Math.floor(STARTING_ZONE.width / 2);
    player.y = Math.floor(STARTING_ZONE.height / 2);
    player.movedAt = this.clock.currentTime;
    this.state.players.set(client.sessionId, player);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
  }
}

/** Coerce an untrusted axis input to -1, 0, or 1. */
function unitStep(value: unknown): number {
  return value === -1 || value === 1 ? value : 0;
}
