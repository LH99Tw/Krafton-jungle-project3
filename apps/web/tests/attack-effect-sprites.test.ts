import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BASIC_ATTACK_SPRITES,
  swordsmanSlashAnimationDirectionForAim,
  swordsmanSlashDirectionForAim,
} from "../src/game/client/render/attackEffectSprites";

test("basic attacks use independent RGBA sprite sheets with complete frame grids", () => {
  const textureKeys = new Set<string>();
  const animationKeys = new Set<string>();

  for (const [classId, sprite] of Object.entries(BASIC_ATTACK_SPRITES)) {
    const png = readFileSync(new URL(`../public${sprite.path}`, import.meta.url));
    assert.equal(png.readUInt32BE(16), sprite.frameWidth * sprite.frameCount, `${classId} sheet width`);
    assert.equal(png.readUInt32BE(20), sprite.frameHeight * (sprite.rows ?? 1), `${classId} sheet height`);
    assert.equal(png[25], 6, `${classId} sprite sheet must use RGBA color data`);
    assert.equal(textureKeys.has(sprite.textureKey), false, `${classId} texture key must be unique`);
    assert.equal(animationKeys.has(sprite.animationKey), false, `${classId} animation key must be unique`);
    textureKeys.add(sprite.textureKey);
    animationKeys.add(sprite.animationKey);
  }
});

test("swordsman slash sheet rows compensate the authored reverse blade direction", () => {
  assert.equal(swordsmanSlashAnimationDirectionForAim(0), "left");
  assert.equal(swordsmanSlashAnimationDirectionForAim(Math.PI / 2), "up");
  assert.equal(swordsmanSlashAnimationDirectionForAim(Math.PI), "right");
  assert.equal(swordsmanSlashAnimationDirectionForAim(-Math.PI / 2), "down");
});

test("swordsman slash aim selects all eight directional sprite rows", () => {
  assert.equal(swordsmanSlashDirectionForAim(0), "right");
  assert.equal(swordsmanSlashDirectionForAim(Math.PI / 4), "down-right");
  assert.equal(swordsmanSlashDirectionForAim(Math.PI / 2), "down");
  assert.equal(swordsmanSlashDirectionForAim(Math.PI * 0.75), "down-left");
  assert.equal(swordsmanSlashDirectionForAim(Math.PI), "left");
  assert.equal(swordsmanSlashDirectionForAim(-Math.PI * 0.75), "up-left");
  assert.equal(swordsmanSlashDirectionForAim(-Math.PI / 2), "up");
  assert.equal(swordsmanSlashDirectionForAim(-Math.PI / 4), "up-right");
});
