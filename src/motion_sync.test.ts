import assert from "node:assert/strict";
import { test } from "node:test";
import type { Player } from "./net/module_bindings/types";
import { isOlderPlayerMotion, playerMotionChanged, withPlayerMotion } from "./motion_sync.js";

function player(over: Partial<Player> = {}): Player {
  return {
    x: 2,
    y: 3,
    dirX: 1,
    dirY: 0,
    running: false,
    path: "",
    movedAt: { microsSinceUnixEpoch: 10n },
    equippedMainHand: "sword",
    equipmentAction: "",
    equipmentActionAt: { microsSinceUnixEpoch: 0n },
    ...over,
  } as Player;
}

test("equipment-only player updates do not count as motion changes", () => {
  const before = player();
  const after = player({
    equipmentAction: "sword",
    equipmentActionAt: { microsSinceUnixEpoch: 20n },
  });

  assert.equal(playerMotionChanged(before, after), false);
});

test("movement-bearing player updates count as motion changes", () => {
  assert.equal(playerMotionChanged(player(), player({ x: 3 })), true);
  assert.equal(playerMotionChanged(player(), player({ movedAt: { microsSinceUnixEpoch: 11n } })), true);
});

test("an older visual player row can preserve the current motion", () => {
  const current = player({ x: 4, y: 3, dirX: 1, movedAt: { microsSinceUnixEpoch: 20n } });
  const incoming = player({
    x: 2,
    y: 3,
    dirX: 1,
    movedAt: { microsSinceUnixEpoch: 10n },
    equipmentAction: "sword",
    equipmentActionAt: { microsSinceUnixEpoch: 30n },
  });

  assert.equal(isOlderPlayerMotion(incoming, current), true);
  assert.deepEqual(withPlayerMotion(incoming, current), {
    ...incoming,
    x: 4,
    y: 3,
    dirX: 1,
    dirY: 0,
    running: false,
    path: "",
    movedAt: { microsSinceUnixEpoch: 20n },
  });
});
