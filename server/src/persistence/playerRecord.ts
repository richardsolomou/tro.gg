/**
 * The durable slice of a player — what survives a disconnect or server restart.
 * A subset of the live {@link Player} schema: motion intents (direction, path,
 * movedAt) are transient and process-relative, so we persist only the settled
 * position. Equipment, skills, and inventory join this with their milestones.
 */
export interface PlayerRecord {
  userId: string;
  name: string;
  isGuest: boolean;
  zoneId: string;
  x: number;
  y: number;
}
