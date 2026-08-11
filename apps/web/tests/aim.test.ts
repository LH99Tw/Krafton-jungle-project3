import assert from "node:assert/strict";
import test from "node:test";
import { aimAngleBetween, normalizeAimAngle } from "../src/game/netcode/aim";

test("mouse aim resolves every cardinal direction and wraps consistently", () => {
  const origin = { x: 100, y: 100 };
  assert.equal(aimAngleBetween(origin, { x: 200, y: 100 }), 0);
  assert.equal(aimAngleBetween(origin, { x: 100, y: 200 }), Math.PI / 2);
  assert.equal(aimAngleBetween(origin, { x: 100, y: 0 }), -Math.PI / 2);
  assert.ok(Math.abs(Math.abs(aimAngleBetween(origin, { x: 0, y: 100 })) - Math.PI) < 1e-12);
  assert.ok(Math.abs(normalizeAimAngle(Math.PI * 3) - Math.PI) < 1e-12);
});
