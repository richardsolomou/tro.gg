import assert from "node:assert/strict";
import { test } from "node:test";
import { GATHER_XP, isSkillId, LEVEL_CAP, levelForXp, SKILL_IDS, xpForLevel } from "./skills";

test("the level curve matches the GDD: level 2 at 50 XP, level 10 at 4,050", () => {
  assert.equal(xpForLevel(1), 0);
  assert.equal(xpForLevel(2), 50);
  assert.equal(xpForLevel(10), 4050);
});

test("levelForXp inverts xpForLevel exactly at every boundary", () => {
  for (let level = 1; level <= LEVEL_CAP; level++) {
    const xp = xpForLevel(level);
    assert.equal(levelForXp(xp), level); // reaching the threshold reaches the level
    if (level > 1) assert.equal(levelForXp(xp - 1), level - 1); // one XP short stays below
  }
});

test("a fresh trogg is level 1, and the cap holds however much XP piles up", () => {
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(-5), 1);
  assert.equal(levelForXp(xpForLevel(LEVEL_CAP) * 100), LEVEL_CAP);
});

test("the AFK gate threshold of 800 XP is exactly overall level 5", () => {
  assert.equal(levelForXp(800), 5);
  assert.equal(levelForXp(799), 4);
  // ~80 breaking hits at the initial gather XP — a first real session
  assert.equal(800 / GATHER_XP, 80);
});

test("skill ids are the shipped trio", () => {
  assert.deepEqual([...SKILL_IDS], ["mining", "woodcutting", "combat"]);
  assert.equal(isSkillId("mining"), true);
  assert.equal(isSkillId("foraging"), false); // joins when glowcap nodes ship
});
