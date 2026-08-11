import assert from "node:assert/strict";
import test from "node:test";
import {
  computeVisibilityPolygon,
  createWallSpatialIndex,
  pointInVisibilityPolygon,
} from "../src/v02/visibility";

test("visibility polygon keeps a closed wall opaque", () => {
  const walls = [
    { x1: 0, y1: 0, x2: 1_000, y2: 0 },
    { x1: 1_000, y1: 0, x2: 1_000, y2: 600 },
    { x1: 1_000, y1: 600, x2: 0, y2: 600 },
    { x1: 0, y1: 600, x2: 0, y2: 0 },
    { x1: 500, y1: 0, x2: 500, y2: 600 },
  ];
  const polygon = computeVisibilityPolygon({ x: 250, y: 300 }, 800, createWallSpatialIndex(walls));
  assert.equal(pointInVisibilityPolygon(polygon, 300, 300), true);
  assert.equal(pointInVisibilityPolygon(polygon, 750, 300), false);
});

test("a doorway only exposes the forward wedge", () => {
  const walls = [
    { x1: 500, y1: 0, x2: 500, y2: 250 },
    { x1: 500, y1: 350, x2: 500, y2: 600 },
  ];
  const polygon = computeVisibilityPolygon({ x: 300, y: 300 }, 500, createWallSpatialIndex(walls));
  assert.equal(pointInVisibilityPolygon(polygon, 650, 300), true);
  assert.equal(pointInVisibilityPolygon(polygon, 650, 100), false);
});
