import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BASIC_ATTACK_ALL_SPRITES,
  BASIC_ATTACK_SPRITES,
  basicAttackSpriteForLevel,
  swordsmanSlashAnimationDirectionForAim,
  swordsmanSlashDirectionForAim,
} from "../src/game/client/render/attackEffectSprites";
import { SKILL_EFFECT_ALL_SPRITES, SKILL_EFFECT_SPRITES } from "../src/game/client/render/skillEffectSprites";

test("basic attacks use independent RGBA sprite sheets with complete frame grids", () => {
  const textureKeys = new Set<string>();
  const animationKeys = new Set<string>();

  for (const [index, sprite] of BASIC_ATTACK_ALL_SPRITES.entries()) {
    const png = readFileSync(new URL(`../public${sprite.path}`, import.meta.url));
    assert.equal(png.readUInt32BE(16), sprite.frameWidth * sprite.frameCount, `${index} sheet width`);
    assert.equal(png.readUInt32BE(20), sprite.frameHeight * (sprite.rows ?? 1), `${index} sheet height`);
    assert.equal(png[25], 6, `${index} sprite sheet must use RGBA color data`);
    assert.equal(textureKeys.has(sprite.textureKey), false, `${index} texture key must be unique`);
    assert.equal(animationKeys.has(sprite.animationKey), false, `${index} animation key must be unique`);
    textureKeys.add(sprite.textureKey);
    animationKeys.add(sprite.animationKey);
  }
});

test("all six class skills use six-frame transparent sprite sheets", () => {
  assert.equal(SKILL_EFFECT_ALL_SPRITES.length, 6);
  for (const sprite of SKILL_EFFECT_ALL_SPRITES) {
    const png = readFileSync(new URL(`../public${sprite.path}`, import.meta.url));
    assert.equal(png.readUInt32BE(16), sprite.frameWidth * sprite.frameCount);
    assert.equal(png.readUInt32BE(20), sprite.frameHeight);
    assert.equal(png[25], 6, `${sprite.path} must use RGBA color data`);
  }
});

test("arrow rain keeps its visual on screen longer without changing combat rules", () => {
  assert.equal(SKILL_EFFECT_SPRITES.archer.e.frameRate, 10);
  assert.equal(SKILL_EFFECT_SPRITES.archer.q.frameRate, 20);
});

test("basic attack sprites advance at levels 10, 20, and 30", () => {
  assert.equal(basicAttackSpriteForLevel("swordsman", 9), BASIC_ATTACK_SPRITES.swordsman);
  assert.match(basicAttackSpriteForLevel("swordsman", 10).path, /level-10/);
  assert.match(basicAttackSpriteForLevel("archer", 19).path, /level-10/);
  assert.match(basicAttackSpriteForLevel("archer", 20).path, /level-20/);
  assert.match(basicAttackSpriteForLevel("mage", 29).path, /level-20/);
  assert.match(basicAttackSpriteForLevel("mage", 30).path, /level-30/);
  assert.match(basicAttackSpriteForLevel("mage", 99).path, /level-30/);
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
