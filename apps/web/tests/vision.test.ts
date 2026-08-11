import assert from "node:assert/strict";
import test from "node:test";
import {
  computeVisibilityPolygon,
  selectVisionRevealSources,
} from "../src/game/runtime/room/vision";
import { boundarySegments } from "../src/game/domain/editorGeometry";

test("player vision keeps priority while installed lanterns are deterministic and bounded", () => {
  const selected = selectVisionRevealSources(
    { id: "player", x: 10, y: 20, radius: 330 },
    [
      { id: "lantern-b", x: 500, y: 400, radius: 180 },
      { id: "lantern-a", x: 300, y: 200, radius: 160 },
      { id: "broken", x: 0, y: 0, radius: 0 },
    ],
    2,
  );

  assert.deepEqual(selected.map((source) => source.id), ["player", "lantern-a"]);
});

test("a narrow corridor reveals its forward wedge but keeps the next room corners behind walls", () => {
  const walls = boundarySegments([
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 100, y: 40, width: 40, height: 20 },
    { x: 140, y: 0, width: 100, height: 100 },
  ]);
  const polygon = computeVisibilityPolygon({ x: 50, y: 50 }, 200, walls);
  assert.equal(pointInPolygon(180, 50, polygon), true, "the open doorway must reveal straight ahead");
  assert.equal(pointInPolygon(180, 15, polygon), false, "the doorway side wall must occlude the far corner");
});

test("an L-shaped corridor does not reveal around its bend", () => {
  const walls = boundarySegments([
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 100, y: 40, width: 80, height: 20 },
    { x: 160, y: 40, width: 20, height: 100 },
    { x: 140, y: 120, width: 100, height: 100 },
  ]);
  const polygon = computeVisibilityPolygon({ x: 50, y: 50 }, 260, walls);
  assert.equal(pointInPolygon(140, 50, polygon), true);
  assert.equal(pointInPolygon(170, 170, polygon), false, "the vertical leg beyond the bend must stay dark");
});

function pointInPolygon(x: number, y: number, points: readonly { x: number; y: number }[]): boolean {
  let inside = false;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current++) {
    const left = points[current]!;
    const right = points[previous]!;
    if ((left.y > y) !== (right.y > y) && x < (right.x - left.x) * (y - left.y) / (right.y - left.y) + left.x) inside = !inside;
  }
  return inside;
}
