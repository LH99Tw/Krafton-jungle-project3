import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import sharp from "sharp";

for (const zone of [1, 2, 3]) {
  test(`zone ${zone} waypoint floor asset is a visible transparent PNG`, async () => {
    const source = readFileSync(new URL(`../public/Asset/waypoints/waypoint-circle-zone-${zone}.png`, import.meta.url));
    const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let transparentPixels = 0;
    let visiblePixels = 0;
    for (let alphaIndex = 3; alphaIndex < data.length; alphaIndex += 4) {
      if (data[alphaIndex] === 0) transparentPixels += 1;
      if (data[alphaIndex]! > 32) visiblePixels += 1;
    }
    assert.equal(info.width, 512);
    assert.equal(info.height, 512);
    assert.ok(transparentPixels > 10_000, "the floor sprite needs a transparent exterior");
    assert.ok(visiblePixels > 100_000, "the floor sprite needs enough visible artwork");
  });
}
