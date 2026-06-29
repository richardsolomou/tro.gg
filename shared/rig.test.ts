import { test } from "node:test";
import assert from "node:assert/strict";

import { armAngle, armGrip, forward, handJoint, jointAt, JOINT_NAMES, skeletonFor, slotAnchor, wieldPose, wieldProfile } from "./rig";
import { FACINGS, FRAME_H, FRAME_W, FRAMES, KINDS } from "./sprites";

test("handJoint is deterministic", () => {
  assert.deepEqual(handJoint("trogg", "down", "walk_a"), handJoint("trogg", "down", "walk_a"));
});

test("slotAnchor generalises handJoint across equip slots", () => {
  assert.deepEqual(slotAnchor("trogg", "mainHand", "down", "idle"), handJoint("trogg", "down", "idle"));
  // the off hand pins to the creature's other hand, not the main one
  assert.notDeepEqual(slotAnchor("trogg", "offHand", "down", "idle"), slotAnchor("trogg", "mainHand", "down", "idle"));
});

test("the off hand draws behind the body except facing down; the main hand only facing up", () => {
  assert.equal(slotAnchor("trogg", "offHand", "down", "idle").behind, false);
  for (const f of ["up", "left", "right"] as const) {
    assert.equal(slotAnchor("trogg", "offHand", f, "idle").behind, true, `off hand should be behind facing ${f}`);
  }
  assert.equal(slotAnchor("trogg", "mainHand", "left", "idle").behind, false);
  assert.equal(slotAnchor("trogg", "mainHand", "up", "idle").behind, true);
});

test("jointAt is rest + this frame's pose offset", () => {
  const rest = skeletonFor("trogg", "down").joints.nearFoot;
  assert.deepEqual(jointAt("trogg", "down", "idle", "nearFoot"), rest);
});

test("the strike throws the main hand forward past rest", () => {
  for (const facing of ["down", "up", "right"] as const) {
    const rest = skeletonFor("trogg", facing).joints.mainHand;
    const strike = jointAt("trogg", facing, "attack_b", "mainHand");
    const f = forward(facing);
    // signed distance along the facing direction is positive (extended)
    const reach = (strike.x - rest.x) * f.x + (strike.y - rest.y) * f.y;
    assert.ok(reach > 0, `${facing} strike should reach forward, got ${reach}`);
  }
});

test("the wind-up cocks the main hand back behind rest", () => {
  for (const facing of ["down", "up", "right"] as const) {
    const rest = skeletonFor("trogg", facing).joints.mainHand;
    const cock = jointAt("trogg", facing, "attack_a", "mainHand");
    const f = forward(facing);
    const reach = (cock.x - rest.x) * f.x + (cock.y - rest.y) * f.y;
    assert.ok(reach < 0, `${facing} wind-up should cock back, got ${reach}`);
  }
});

test("the main arm/item sits behind the body only when facing up", () => {
  assert.equal(skeletonFor("trogg", "up").behind, true);
  for (const facing of ["down", "left", "right"] as const) {
    assert.equal(skeletonFor("trogg", facing).behind, false);
  }
});

test("left and right share the side skeleton, for every kind (the runtime mirrors)", () => {
  for (const kind of KINDS) {
    assert.deepEqual(skeletonFor(kind, "left").joints, skeletonFor(kind, "right").joints);
  }
});

test("every joint stays within the frame, for all kinds/facings/frames", () => {
  for (const kind of KINDS)
    for (const facing of FACINGS)
      for (const frame of FRAMES)
        for (const joint of JOINT_NAMES) {
          const j = jointAt(kind, facing, frame, joint);
          assert.ok(j.x >= 0 && j.x <= FRAME_W, `${kind} ${facing} ${frame} ${joint}: x=${j.x} outside [0, ${FRAME_W}]`);
          assert.ok(j.y >= 0 && j.y <= FRAME_H, `${kind} ${facing} ${frame} ${joint}: y=${j.y} outside [0, ${FRAME_H}]`);
        }
});

test("the hog has its own skeleton, not the trogg's", () => {
  assert.notDeepEqual(skeletonFor("hog", "down").joints, skeletonFor("trogg", "down").joints);
  assert.equal(skeletonFor("hog", "up").behind, true);
});

test("a hog's held hand swings with the gait and reaches on attack (it shares the rig)", () => {
  const idleDown = handJoint("hog", "down", "idle");
  // the front gait swings the hand vertically, the side gait horizontally
  assert.notEqual(handJoint("hog", "down", "walk_a").y, idleDown.y);
  assert.notEqual(handJoint("hog", "right", "walk_a").x, handJoint("hog", "right", "idle").x);
  // hogs share the rig's attack reach now: the main hand cocks back, then throws forward
  assert.equal(handJoint("hog", "down", "attack_b").y > idleDown.y, true);
  assert.equal(handJoint("hog", "down", "attack_a").y < idleDown.y, true);
});

test("unknown items get a neutral wield profile", () => {
  const p = wieldProfile("nonesuch");
  assert.deepEqual(p.hold, { rot: 0, reach: 0, lift: 0, scale: 1 });
  assert.deepEqual(p.use, { rot: 0, reach: 0, lift: 0, scale: 1 });
});

test("tools rigidly follow the forearm; the sword keeps a fixed grip", () => {
  assert.notEqual(armGrip("pickaxe"), undefined);
  assert.notEqual(armGrip("shovel"), undefined);
  assert.equal(armGrip("sword"), undefined);
});

test("the main arm swings forward from wind-up to strike, so a tool swings with it", () => {
  const windup = armAngle("trogg", "right", "attack_a");
  const strike = armAngle("trogg", "right", "attack_b");
  assert.ok(strike < windup, "the strike forearm is rotated forward of the wind-up");
});

test("wieldPose eases hold→use", () => {
  assert.deepEqual(wieldPose("sword", 0), wieldProfile("sword").hold);
  assert.deepEqual(wieldPose("sword", 1), wieldProfile("sword").use);
  // midway sits between the two on the eased axis (reach)
  const mid = wieldPose("sword", 0.5).reach;
  assert.ok(mid > wieldProfile("sword").hold.reach && mid < wieldProfile("sword").use.reach);
});
