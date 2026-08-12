import assert from "node:assert/strict";
import test from "node:test";
import { selectAutoAttackTargets } from "../src/game/domain/autoAttackTargeting";

test("auto attack prefers a target inside the cursor cone", () => {
  const targets = selectAutoAttackTargets(
    { x: 0, y: 0, aim: 0 },
    [
      { id: "near-behind", x: -20, y: 0 },
      { id: "aimed", x: 80, y: 0 },
    ],
    100,
    Math.PI / 6,
    () => true,
  );

  assert.deepEqual(targets.map(({ id }) => id), ["aimed"]);
});

test("auto attack falls back to the nearest visible target outside the cursor cone", () => {
  const targets = selectAutoAttackTargets(
    { x: 0, y: 0, aim: 0 },
    [
      { id: "far-behind", x: -90, y: 0 },
      { id: "near-behind", x: -30, y: 0 },
      { id: "blocked", x: 10, y: 0 },
    ],
    100,
    Math.PI / 6,
    ({ id }) => id !== "blocked",
  );

  assert.deepEqual(targets.map(({ id }) => id), ["near-behind", "far-behind"]);
});
