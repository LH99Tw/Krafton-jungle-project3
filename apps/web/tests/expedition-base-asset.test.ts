import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import sharp from "sharp";

const source = new URL("../public/Asset/environment/expedition-base-house-v1.png", import.meta.url);

test("expedition base is a compact transparent gameplay asset", async () => {
  const input = readFileSync(source);
  const metadata = await sharp(input).metadata();
  assert.equal(metadata.width, 768);
  assert.equal(metadata.height, 512);
  assert.equal(metadata.hasAlpha, true);

  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...data.subarray(0, 4)], [0, 0, 0, 0]);
  const alpha = data.filter((_, index) => index % info.channels === 3);
  assert.ok(alpha.some((value) => value > 240), "base house must contain opaque pixels");
  assert.ok(alpha.some((value) => value === 0), "base house must retain transparent surroundings");
});
