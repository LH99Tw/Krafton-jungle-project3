import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import sharp from "sharp";
import {
  DEFAULT_HERO_FACING,
  HERO_DIRECTION_COUNT,
  HERO_SPRITE_FRAME_SIZE,
  HERO_SPRITE_PATHS,
  HERO_TOTAL_FRAME_COUNT,
  HERO_WALK_PHASE_DURATION_MS,
  heroFacingForAim,
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

test("snaps attack aim to the matching four-direction hero facing", () => {
  assert.equal(heroFacingForAim(0), "right");
  assert.equal(heroFacingForAim(Math.PI / 2), "down");
  assert.equal(heroFacingForAim(Math.PI), "left");
  assert.equal(heroFacingForAim(-Math.PI / 2), "up");
  assert.equal(heroFacingForAim(Math.PI * 0.75), "left");
});

test("cycles walk1, idle, walk2, and idle without changing direction", () => {
  assert.equal(heroFrameForPose("right", false, 0), 1);
  assert.equal(heroFrameForPose("right", true, 0), 5);
  assert.equal(heroFrameForPose("right", true, HERO_WALK_PHASE_DURATION_MS), 1);
  assert.equal(heroFrameForPose("right", true, HERO_WALK_PHASE_DURATION_MS * 2), 9);
  assert.equal(heroFrameForPose("right", true, HERO_WALK_PHASE_DURATION_MS * 3), 1);
  assert.equal(heroFrameForPose("right", true, HERO_WALK_PHASE_DURATION_MS * 4), 5);
  assert.equal(heroFrameForPose("right", true, -1), 5);
});

test("sprite assets match the expected RGBA 4 by 3 grid", () => {
  for (const spritePath of Object.values(HERO_SPRITE_PATHS)) {
    const png = readFileSync(new URL(`../public${spritePath}`, import.meta.url));
    assert.equal(png.readUInt32BE(16), HERO_SPRITE_FRAME_SIZE * HERO_DIRECTION_COUNT, spritePath);
    assert.equal(png.readUInt32BE(20), HERO_SPRITE_FRAME_SIZE * 3, spritePath);
    assert.equal(png[25], 6, `${spritePath} must use RGBA color data`);
  }
});

test("mage frames share one ground line and contain no lower-frame debris", async () => {
  const magePath = HERO_SPRITE_PATHS.mage;
  assert.match(magePath, /-v2\.png$/, "corrected mage sheets must use a cache-busting filename");
  const { data, info } = await sharp(readFileSync(new URL(`../public${magePath}`, import.meta.url)))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < HERO_DIRECTION_COUNT; column += 1) {
      let bottom = -1;
      const occupied = new Uint8Array(HERO_SPRITE_FRAME_SIZE ** 2);
      for (let y = 0; y < HERO_SPRITE_FRAME_SIZE; y += 1) {
        for (let x = 0; x < HERO_SPRITE_FRAME_SIZE; x += 1) {
          const sourceX = column * HERO_SPRITE_FRAME_SIZE + x;
          const sourceY = row * HERO_SPRITE_FRAME_SIZE + y;
          const alpha = data[(sourceY * info.width + sourceX) * info.channels + 3];
          if (alpha > 8) {
            occupied[y * HERO_SPRITE_FRAME_SIZE + x] = 1;
            bottom = y;
          }
        }
      }
      assert.equal(bottom, 345, `mage row ${row}, column ${column} must use the shared foot baseline`);
      assert.equal(countComponents(occupied, HERO_SPRITE_FRAME_SIZE), 1, `mage row ${row}, column ${column} contains debris`);
    }
  }
});

function countComponents(occupied: Uint8Array, width: number): number {
  const visited = new Uint8Array(occupied.length);
  const queue = new Int32Array(occupied.length);
  let components = 0;

  for (let start = 0; start < occupied.length; start += 1) {
    if (!occupied[start] || visited[start]) continue;
    components += 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const neighbors = [index - width, index + width, x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1];
      for (const neighbor of neighbors) {
        if (neighbor >= 0 && neighbor < occupied.length && occupied[neighbor] && !visited[neighbor]) {
          visited[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
    }
  }
  return components;
}
