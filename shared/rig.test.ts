import { test } from "node:test";
import assert from "node:assert/strict";

import { armAngle, bodyLean, forward, gripRotation, handJoint, jointAt, JOINT_NAMES, skeletonFor, slotAnchor, wieldPose, wieldProfile } from "./rig";
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

test("a side stride scissors the feet: the lifted foot swings ahead, the planted trails back", () => {
  for (const kind of KINDS) {
    const rest = skeletonFor(kind, "right").joints;
    const near = jointAt(kind, "right", "walk_a", "nearFoot");
    const far = jointAt(kind, "right", "walk_a", "farFoot");
    assert.ok(near.x > rest.nearFoot.x, `${kind}: lifted near foot should swing ahead`);
    assert.ok(near.y < rest.nearFoot.y, `${kind}: lifted near foot should lift`);
    assert.ok(far.x < rest.farFoot.x, `${kind}: planted far foot should trail back`);
    assert.equal(far.y, rest.farFoot.y, `${kind}: planted far foot stays on the ground`);
  }
});

test("down/up strides keep the plain alternating lift — no scissor across the camera axis", () => {
  for (const facing of ["down", "up"] as const) {
    const rest = skeletonFor("trogg", facing).joints.nearFoot;
    const near = jointAt("trogg", facing, "walk_a", "nearFoot");
    assert.equal(near.x, rest.x, `${facing}: feet should not shift sideways`);
    assert.ok(near.y < rest.y, `${facing}: the striding foot still lifts`);
  }
});

test("the upper body leans on side facings: the run hunch and the attack weight shift", () => {
  // running leans forward; the wind-up pulls back; the strike throws forward
  assert.ok(bodyLean("trogg", "right", "run_a") > 0);
  assert.ok(bodyLean("trogg", "right", "attack_a") < 0);
  assert.ok(bodyLean("trogg", "right", "attack_b") > 0);
  // down/up look along the lean, so nothing shifts
  assert.equal(bodyLean("trogg", "down", "run_a"), 0);
  // the shoulders carry the lean, so the drawn arms stay rooted to the leaning torso
  const rest = skeletonFor("trogg", "right").joints.mainShoulder;
  assert.ok(jointAt("trogg", "right", "run_a", "mainShoulder").x > rest.x);
});

test("unknown items get a neutral wield profile", () => {
  const p = wieldProfile("nonesuch");
  assert.deepEqual(p.hold, { rot: 0, reach: 0, lift: 0, scale: 1 });
  assert.deepEqual(p.use, { rot: 0, reach: 0, lift: 0, scale: 1 });
});

test("grip tools have an explicit per-phase swing rotation; the sword does not", () => {
  assert.notEqual(gripRotation("pickaxe", "attack_b"), undefined);
  assert.notEqual(gripRotation("shovel", "attack_b"), undefined);
  // the wind-up and strike rotate the tool differently (raised then chopped)
  assert.notEqual(gripRotation("pickaxe", "attack_a"), gripRotation("pickaxe", "attack_b"));
  assert.equal(gripRotation("sword", "attack_b"), undefined);
});

test("the main arm swings forward from wind-up to strike, so a tool swings with it", () => {
  const windup = armAngle("trogg", "right", "attack_a");
  const strike = armAngle("trogg", "right", "attack_b");
  assert.ok(strike < windup, "the strike forearm is rotated forward of the wind-up");
});

test("wieldPose returns the exact endpoint poses and lerps between", () => {
  // exact endpoints (no float drift) at the bounds, for any item
  assert.deepEqual(wieldPose("pickaxe", 0), wieldProfile("pickaxe").hold);
  assert.deepEqual(wieldPose("pickaxe", 1), wieldProfile("pickaxe").use);
  // a synthetic differing hold→use lerps each axis halfway at k=0.5
  assert.deepEqual(wieldPose("nonesuch", 0.5), { rot: 0, reach: 0, lift: 0, scale: 1 });
});

test("the sword has no hold→use offset, so it rides the hand joint without drifting off the arm", () => {
  const s = wieldProfile("sword");
  assert.deepEqual(s.hold, s.use);
});
