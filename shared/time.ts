/** A SpacetimeDB timestamp narrowed to the field both sides read. */
export interface Stamp {
  microsSinceUnixEpoch: bigint;
}

/** A timestamp as whole milliseconds since the Unix epoch, for mapping onto the
 *  millisecond clocks (`Date.now`, `performance.now`) the client animates against. */
export function timestampMs(ts: Stamp): number {
  return Number(ts.microsSinceUnixEpoch / 1000n);
}

/** Milliseconds between two timestamps, keeping sub-millisecond precision. */
export function elapsedMs(from: Stamp, to: Stamp): number {
  return Number(to.microsSinceUnixEpoch - from.microsSinceUnixEpoch) / 1000;
}
