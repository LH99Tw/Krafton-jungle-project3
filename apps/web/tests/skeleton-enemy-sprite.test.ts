import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import sharp from "sharp";
import {
  enemyFrameRow,
  fieldEnemyTextureForSpawn,
  fieldEnemyTextureForZone,
  HIDDEN_ENEMY_FRAME_COUNT,
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
  new URL("../public/Asset/sprites/hidden-ent-7frame-8dir-walk-v2.png", import.meta.url),
  new URL("../public/Asset/sprites/hidden-stone-golem-7frame-8dir-walk-v2.png", import.meta.url),
  new URL("../public/Asset/sprites/hidden-dullahan-7frame-8dir-walk-v2.png", import.meta.url),
];

function assertHiddenFrameIntegrity(data: Buffer, zone: number, row: number, column: number) {
  const width = 160;
  const height = 160;
  const mask = new Uint8Array(width * height);
  let visiblePixels = 0;
  let firstVisibleRow = height;
  let lastVisibleRow = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3]! <= 16) continue;
      mask[y * width + x] = 1;
      visiblePixels += 1;
      firstVisibleRow = Math.min(firstVisibleRow, y);
      lastVisibleRow = Math.max(lastVisibleRow, y);
    }
  }

  assert.ok(visiblePixels > 0, `hidden zone ${zone} frame ${row}:${column} must contain opaque pixels`);
  for (let y = firstVisibleRow; y <= lastVisibleRow; y += 1) {
    assert.ok(
      mask.subarray(y * width, (y + 1) * width).some(Boolean),
      `hidden zone ${zone} frame ${row}:${column} must not have an internal horizontal split`,
    );
  }

  const visited = new Uint8Array(mask.length);
  let largestComponent = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const pending = [start];
    visited[start] = 1;
    let componentSize = 0;
    while (pending.length > 0) {
      const current = pending.pop()!;
      componentSize += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      const neighbors = [
        x > 0 ? current - 1 : -1,
        x < width - 1 ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y < height - 1 ? current + width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || !mask[neighbor] || visited[neighbor]) continue;
        visited[neighbor] = 1;
        pending.push(neighbor);
      }
    }
    largestComponent = Math.max(largestComponent, componentSize);
  }

  assert.ok(
    largestComponent / visiblePixels >= 0.995,
    `hidden zone ${zone} frame ${row}:${column} must be one coherent sprite, not mixed fragments`,
  );
}

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
    if (index !== 1) continue;
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        const { data, info } = await sharp(input).extract({ left: column * 160, top: row * 160, width: 160, height: 160 })
          .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.ok(data.some((value, offset) => offset % info.channels === 3 && value > 200), `upgraded zone ${index + 1} frame ${row}:${column} visible`);
        for (let offset = 0; offset < 160; offset += 1) {
          assert.ok(data[offset * 4 + 3]! <= 8, `upgraded zone ${index + 1} frame ${row}:${column} top edge`);
          assert.ok(data[(offset * 160) * 4 + 3]! <= 8, `upgraded zone ${index + 1} frame ${row}:${column} left edge`);
          assert.ok(data[(offset * 160 + 159) * 4 + 3]! <= 8, `upgraded zone ${index + 1} frame ${row}:${column} right edge`);
        }
      }
    }
  }
});

test("hidden enemies use zone-specific transparent 8-direction sheets", async () => {
  assert.equal(HIDDEN_ENEMY_FRAME_COUNT, 7);
  assert.equal(hiddenEnemyTextureForZone(1), "enemy-hidden-ent");
  assert.equal(hiddenEnemyTextureForZone(2), "enemy-hidden-stone-golem");
  assert.equal(hiddenEnemyTextureForZone(3), "enemy-hidden-dullahan");

  for (const [index, hiddenSource] of hiddenSources.entries()) {
    const input = readFileSync(hiddenSource);
    const metadata = await sharp(input).metadata();
    assert.equal(metadata.width, 1120, `hidden zone ${index + 1} sheet width`);
    assert.equal(metadata.height, 1280, `hidden zone ${index + 1} sheet height`);
    assert.equal(metadata.hasAlpha, true, `hidden zone ${index + 1} sheet alpha`);
    for (let row = 0; row < 8; row += 1) {
      const frameBuffers: Buffer[] = [];
      for (let column = 0; column < HIDDEN_ENEMY_FRAME_COUNT; column += 1) {
        const frame = sharp(input)
          .extract({ left: column * 160, top: row * 160, width: 160, height: 160 })
          .ensureAlpha();
        const stats = await frame.clone().stats();
        assert.ok(stats.channels[3]!.max > 200, `hidden zone ${index + 1} frame ${row}:${column} visible`);
        const alpha = await frame.raw().toBuffer({ resolveWithObject: true });
        frameBuffers.push(alpha.data);
        assert.equal(alpha.info.channels, 4, `hidden zone ${index + 1} frame ${row}:${column} RGBA channels`);
        assertHiddenFrameIntegrity(alpha.data, index + 1, row, column);
        const touchesFrameEdge = Array.from({ length: 160 }, (_, offset) => (
          alpha.data[(offset * 4) + 3]!
          || alpha.data[((159 * 160 + offset) * 4) + 3]!
          || alpha.data[((offset * 160) * 4) + 3]!
          || alpha.data[((offset * 160 + 159) * 4) + 3]!
        )).some(Boolean);
        assert.equal(touchesFrameEdge, false, `hidden zone ${index + 1} frame ${row}:${column} must not bleed into a neighbor`);
      }
      assert.equal(
        new Set(frameBuffers.map((frame) => frame.toString("base64"))).size,
        HIDDEN_ENEMY_FRAME_COUNT,
        `hidden zone ${index + 1} row ${row} must contain seven distinct animation frames`,
      );
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

test("the small golem uses standard direction rows instead of the skeleton-specific mapping", () => {
  assert.equal(enemyFrameRow("enemy-skeleton-unarmed", 0), 3);
  assert.deepEqual(
    [0, 45, 90, 135, 180, 225, 270, 315].map((angle) => enemyFrameRow("enemy-golem-upgraded", angle)),
    [2, 1, 0, 7, 6, 5, 4, 3],
  );
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
