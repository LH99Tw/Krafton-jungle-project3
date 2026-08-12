import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import sharp from "sharp";
import { resolveEnemyFacingAngle, SKELETON_ROW_BY_ANGLE } from "../src/game/client/render/enemySprites";

const source = new URL("../public/Asset/sprites/skeleton-unarmed-8dir-walk-v1.png", import.meta.url);

test("unarmed skeleton sheet is a transparent 8-direction by 8-frame grid", async () => {
  const { data, info } = await sharp(readFileSync(source)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1280);
  assert.equal(info.height, 1280);
  assert.equal(info.width % 8, 0);
  assert.equal(info.height % 8, 0);
  assert.deepEqual([...data.subarray(0, 4)], [0, 0, 0, 0]);

  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const left = column * 160;
      const top = row * 160;
      const stats = await sharp(readFileSync(source)).extract({ left, top, width: 160, height: 160 }).stats();
      assert.ok(stats.channels[3]!.max > 200, `frame ${row}:${column} must contain a visible skeleton`);
    }
  }
});

test("skeleton direction rows map to the runtime's east-zero angles", () => {
  assert.deepEqual(SKELETON_ROW_BY_ANGLE, { 0: 2, 45: 1, 90: 0, 135: 7, 180: 6, 225: 5, 270: 4, 315: 3 });
});

test("moving skeletons face their movement direction instead of stale server aim", () => {
  assert.equal(resolveEnemyFacingAngle({ movementX: 80, movementY: 0, aimRadians: Math.PI }), 0);
  assert.equal(resolveEnemyFacingAngle({ movementX: 80, movementY: 80 }), 45);
  assert.equal(resolveEnemyFacingAngle({ movementX: 0, movementY: 80 }), 90);
  assert.equal(resolveEnemyFacingAngle({ movementX: -80, movementY: 80 }), 135);
  assert.equal(resolveEnemyFacingAngle({ movementX: -80, movementY: 0 }), 180);
  assert.equal(resolveEnemyFacingAngle({ movementX: -80, movementY: -80 }), 225);
  assert.equal(resolveEnemyFacingAngle({ movementX: 0, movementY: -80 }), 270);
  assert.equal(resolveEnemyFacingAngle({ movementX: 80, movementY: -80 }), 315);
});

test("attack targets override movement and idle enemies keep their last facing", () => {
  assert.equal(resolveEnemyFacingAngle({
    movementX: 80,
    movementY: 0,
    targetDeltaX: -100,
    targetDeltaY: 0,
  }), 180);
  assert.equal(resolveEnemyFacingAngle({ previousAngle: 315 }), 315);
});
