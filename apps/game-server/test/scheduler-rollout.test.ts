import assert from "node:assert/strict";
import test from "node:test";
import { SchedulerRolloutController } from "../src/scheduler-rollout";

const healthy = {
  elapsedMs: 10_000,
  simulationTicks: 4_000,
  coreUpdateMs: 2,
  droppedCatchUp: false,
  oldestPathWaitSeconds: 0,
  generatedActions: 4,
  transmittedActions: 4,
} as const;

test("scheduler rollout promotes 10 to 50 to 100 only after both evidence gates", () => {
  const rollout = new SchedulerRolloutController(false, 10);
  for (let index = 0; index < 25; index += 1) rollout.observe(healthy);
  assert.equal(rollout.percent, 10, "five room-minutes are required in addition to 100k ticks");
  for (let index = 0; index < 5; index += 1) rollout.observe(healthy);
  assert.equal(rollout.percent, 50);
  for (let index = 0; index < 30; index += 1) rollout.observe(healthy);
  assert.equal(rollout.percent, 100);
});

test("scheduler rollout rolls back after two consecutive unhealthy windows", () => {
  const rollout = new SchedulerRolloutController(false, 50);
  const unhealthy = { ...healthy, coreUpdateMs: 13 };
  rollout.observe(unhealthy);
  rollout.observe(unhealthy);
  assert.equal(rollout.percent, 10);
});

test("scheduler runtime kill switch keeps every room on the legacy path", () => {
  const rollout = new SchedulerRolloutController(true, 100);
  assert.equal(rollout.percent, 0);
  assert.equal(rollout.enabledFor("any-room"), false);
});
