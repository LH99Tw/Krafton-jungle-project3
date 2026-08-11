import assert from "node:assert/strict";
import test from "node:test";
import { heroFrameForAimAngle } from "../src/game/client/render/heroSprites";

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
