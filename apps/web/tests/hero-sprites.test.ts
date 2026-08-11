import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_HERO_FACING,
  HERO_DIRECTION_COUNT,
  HERO_SPRITE_FRAME_SIZE,
  HERO_SPRITE_PATHS,
  HERO_TOTAL_FRAME_COUNT,
  HERO_WALK_PHASE_DURATION_MS,
  heroFacingForMovement,
  heroFrameForPose,
} from "../src/game/client/render/heroSprites";

test("uses a four-direction, three-row sprite grid", () => {
  assert.equal(HERO_SPRITE_FRAME_SIZE, 362);
  assert.equal(HERO_DIRECTION_COUNT, 4);
  assert.equal(HERO_TOTAL_FRAME_COUNT, 12);
});

test("maps cardinal movement to down, right, up, and left facing", () => {
  assert.equal(heroFacingForMovement(DEFAULT_HERO_FACING, 0, 1), "down");
  assert.equal(heroFacingForMovement(DEFAULT_HERO_FACING, 1, 0), "right");
  assert.equal(heroFacingForMovement(DEFAULT_HERO_FACING, 0, -1), "up");
  assert.equal(heroFacingForMovement(DEFAULT_HERO_FACING, -1, 0), "left");
});

test("diagonal and idle movement preserve the last cardinal facing", () => {
  const up = heroFacingForMovement(DEFAULT_HERO_FACING, 0, -1);
  assert.equal(heroFacingForMovement(up, 1, -1), "up", "W followed by W+D keeps up facing");

  const right = heroFacingForMovement(DEFAULT_HERO_FACING, 1, 0);
  assert.equal(heroFacingForMovement(right, 1, -1), "right", "D followed by D+W keeps right facing");
  assert.equal(heroFacingForMovement("left", 0, 0), "left");
});

test("uses idle, left-foot, and right-foot rows without changing direction", () => {
  assert.equal(heroFrameForPose("right", false, 0), 1);
  assert.equal(heroFrameForPose("right", true, 0), 5);
  assert.equal(heroFrameForPose("right", true, HERO_WALK_PHASE_DURATION_MS), 9);
  assert.equal(heroFrameForPose("right", true, HERO_WALK_PHASE_DURATION_MS * 2), 5);
});

test("sprite assets match the expected RGBA 4 by 3 grid", () => {
  for (const spritePath of Object.values(HERO_SPRITE_PATHS)) {
    const png = readFileSync(new URL(`../public${spritePath}`, import.meta.url));
    assert.equal(png.readUInt32BE(16), HERO_SPRITE_FRAME_SIZE * HERO_DIRECTION_COUNT, spritePath);
    assert.equal(png.readUInt32BE(20), HERO_SPRITE_FRAME_SIZE * 3, spritePath);
    assert.equal(png[25], 6, `${spritePath} must use RGBA color data`);
  }
});
