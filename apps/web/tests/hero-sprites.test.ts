import assert from "node:assert/strict";
import test from "node:test";
import {
  HERO_WALK_PHASE_DURATION_MS,
  heroFrameForAimAngle,
  heroFrameForPose,
} from "../src/game/client/render/heroSprites";

test("maps clockwise cursor aim octants to the matching sprite frame", () => {
  const step = Math.PI / 4;
  for (let frame = 0; frame < 8; frame += 1) {
    assert.equal(heroFrameForAimAngle(frame * step), frame);
  }
});

test("wraps negative and full-turn aim angles", () => {
  assert.equal(heroFrameForAimAngle(-Math.PI / 4), 7);
  assert.equal(heroFrameForAimAngle(Math.PI * 2), 0);
});

test("uses idle, left-foot, and right-foot rows without changing direction", () => {
  const southeast = Math.PI / 4;
  assert.equal(heroFrameForPose(southeast, false, 0), 1);
  assert.equal(heroFrameForPose(southeast, true, 0), 9);
  assert.equal(heroFrameForPose(southeast, true, HERO_WALK_PHASE_DURATION_MS), 17);
  assert.equal(heroFrameForPose(southeast, true, HERO_WALK_PHASE_DURATION_MS * 2), 9);
});
