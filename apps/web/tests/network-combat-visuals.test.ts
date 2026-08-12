import assert from "node:assert/strict";
import test from "node:test";
import { alignEnemyAttackToRenderTimeline } from "../src/game/runtime/room/networkCombatVisuals";

test("enemy attacks translate authoritative aim onto the interpolated attacker position", () => {
  const target = alignEnemyAttackToRenderTimeline({
    startX: 100,
    startY: 50,
    targetX: 140,
    targetY: 50,
    aim: 0,
  }, { x: 80, y: 50 }, null);

  assert.deepEqual(target, { x: 120, y: 50 });
});

test("enemy attacks use the rendered player position when the target is visible", () => {
  const target = alignEnemyAttackToRenderTimeline({
    startX: 100,
    startY: 50,
    targetX: 140,
    targetY: 50,
    aim: 0,
  }, { x: 80, y: 50 }, { x: 116, y: 54 });

  assert.deepEqual(target, { x: 116, y: 54 });
});
