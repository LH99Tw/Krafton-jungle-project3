import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import sharp from "sharp";
import {
  fieldEnemyTextureForSpawn,
  fieldEnemyTextureForZone,
  hiddenEnemyTextureForZone,
  resolveEnemyFacingAngle,
  SKELETON_ROW_BY_ANGLE,
  usesUpgradedFieldEnemySkin,
} from "../src/game/client/render/enemySprites";

const source = new URL("../public/Asset/sprites/skeleton-unarmed-8dir-walk-v1.png", import.meta.url);
const zoneSources = [
  new URL("../public/Asset/sprites/goblin-unarmed-8dir-walk-v1.png", import.meta.url),
  source,
  new URL("../public/Asset/sprites/demon-unarmed-8dir-walk-v1.png", import.meta.url),
];
const upgradedSources = [
  new URL("../public/Asset/sprites/frog-upgraded-8dir-walk-v1.png", import.meta.url),
  new URL("../public/Asset/sprites/golem-upgraded-8dir-walk-v1.png", import.meta.url),
  new URL("../public/Asset/sprites/succubus-upgraded-8dir-walk-v1.png", import.meta.url),
];
const hiddenSources = [
  new URL("../public/Asset/sprites/hidden-ent-8dir-walk-v1.png", import.meta.url),
  new URL("../public/Asset/sprites/hidden-stone-golem-8dir-walk-v1.png", import.meta.url),
  new URL("../public/Asset/sprites/hidden-dullahan-8dir-walk-v1.png", import.meta.url),
];

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

test("all three zone field enemies use transparent 8-direction by 8-frame sheets", async () => {
  for (const [index, zoneSource] of zoneSources.entries()) {
    const input = readFileSync(zoneSource);
    const metadata = await sharp(input).metadata();
    assert.equal(metadata.width, 1280, `zone ${index + 1} sheet width`);
    assert.equal(metadata.height, 1280, `zone ${index + 1} sheet height`);
    assert.equal(metadata.hasAlpha, true, `zone ${index + 1} sheet alpha`);
    const corner = await sharp(input).ensureAlpha().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    assert.equal(corner[3], 0, `zone ${index + 1} sheet corner must be transparent`);
  }
});

test("field enemy textures change from goblin to skeleton to demon by zone", () => {
  assert.equal(fieldEnemyTextureForZone(1), "enemy-goblin-unarmed");
  assert.equal(fieldEnemyTextureForZone(2), "enemy-skeleton-unarmed");
  assert.equal(fieldEnemyTextureForZone(3), "enemy-lesser-demon-unarmed");
});

test("all upgraded field enemy skins use transparent 8-direction by 8-frame sheets", async () => {
  for (const [index, upgradedSource] of upgradedSources.entries()) {
    const input = readFileSync(upgradedSource);
    const metadata = await sharp(input).metadata();
    assert.equal(metadata.width, 1280, `upgraded zone ${index + 1} sheet width`);
    assert.equal(metadata.height, 1280, `upgraded zone ${index + 1} sheet height`);
    assert.equal(metadata.hasAlpha, true, `upgraded zone ${index + 1} sheet alpha`);
    const corner = await sharp(input).ensureAlpha().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    assert.equal(corner[3], 0, `upgraded zone ${index + 1} sheet corner must be transparent`);
  }
});

test("hidden enemies use zone-specific transparent 8-direction sheets", async () => {
  assert.equal(hiddenEnemyTextureForZone(1), "enemy-hidden-ent");
  assert.equal(hiddenEnemyTextureForZone(2), "enemy-hidden-stone-golem");
  assert.equal(hiddenEnemyTextureForZone(3), "enemy-hidden-dullahan");

  for (const [index, hiddenSource] of hiddenSources.entries()) {
    const input = readFileSync(hiddenSource);
    const metadata = await sharp(input).metadata();
    assert.equal(metadata.width, 1280, `hidden zone ${index + 1} sheet width`);
    assert.equal(metadata.height, 1280, `hidden zone ${index + 1} sheet height`);
    assert.equal(metadata.hasAlpha, true, `hidden zone ${index + 1} sheet alpha`);
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        const frame = sharp(input)
          .extract({ left: column * 160, top: row * 160, width: 160, height: 160 })
          .ensureAlpha();
        const stats = await frame.clone().stats();
        assert.ok(stats.channels[3]!.max > 200, `hidden zone ${index + 1} frame ${row}:${column} visible`);
        const alpha = await frame.raw().toBuffer({ resolveWithObject: true });
        const touchesFrameEdge = Array.from({ length: 160 }, (_, offset) => (
          alpha.data[(offset * 4) + 3]!
          || alpha.data[((159 * 160 + offset) * 4) + 3]!
          || alpha.data[((offset * 160) * 4) + 3]!
          || alpha.data[((offset * 160 + 159) * 4) + 3]!
        )).some(Boolean);
        assert.equal(touchesFrameEdge, false, `hidden zone ${index + 1} frame ${row}:${column} must not bleed into a neighbor`);
      }
    }
  }
});

test("upgraded skin selection is deterministic and exactly one in every 30 hash buckets", () => {
  const samples = Array.from({ length: 5_000 }, (_, index) => `enemy:${index}`);
  for (const enemyId of samples) assert.equal(usesUpgradedFieldEnemySkin(enemyId), usesUpgradedFieldEnemySkin(enemyId));
  const upgradedId = samples.find(usesUpgradedFieldEnemySkin);
  const normalId = samples.find((enemyId) => !usesUpgradedFieldEnemySkin(enemyId));
  assert.ok(upgradedId);
  assert.ok(normalId);
  assert.equal(fieldEnemyTextureForSpawn(1, upgradedId), "enemy-frog-upgraded");
  assert.equal(fieldEnemyTextureForSpawn(2, upgradedId), "enemy-golem-upgraded");
  assert.equal(fieldEnemyTextureForSpawn(3, upgradedId), "enemy-succubus-upgraded");
  assert.equal(fieldEnemyTextureForSpawn(1, normalId), "enemy-goblin-unarmed");
});

test("skeleton direction rows map to the runtime's east-zero angles", () => {
  assert.deepEqual(SKELETON_ROW_BY_ANGLE, { 0: 3, 45: 1, 90: 0, 135: 5, 180: 2, 225: 6, 270: 4, 315: 7 });
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
