import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCellRanges,
  cellIndexAt,
  createExplorationMask,
  createMiniMapGrid,
  encodeCellRanges,
  explorationPercent,
  isExplored,
  rectToMiniMapSurface,
  revealAround,
} from "../src/v02/minimap";
import { PLAYER_VISION_RADIUS, type MiniMapGeometry } from "@five-days/protocol";

function geometry(width = 2_000, height = 1_000): MiniMapGeometry {
  const bounds = { x: 0, y: 0, width, height };
  return {
    mapRevision: "test-map", areaId: "zone-1", bounds, ...createMiniMapGrid(bounds),
    surfaces: [rectToMiniMapSurface(bounds, "surface")],
    wallSegments: [
      { x1: bounds.x, y1: bounds.y, x2: bounds.x + bounds.width, y2: bounds.y },
      { x1: bounds.x + bounds.width, y1: bounds.y, x2: bounds.x + bounds.width, y2: bounds.y + bounds.height },
      { x1: bounds.x + bounds.width, y1: bounds.y + bounds.height, x2: bounds.x, y2: bounds.y + bounds.height },
      { x1: bounds.x, y1: bounds.y + bounds.height, x2: bounds.x, y2: bounds.y },
    ],
    visionRadius: PLAYER_VISION_RADIUS,
    markers: [],
  };
}

test("three party paths merge into one exploration mask", () => {
  const map = geometry();
  const mask = createExplorationMask(map);
  const paths = [[200, 200], [1_000, 500], [1_800, 800]] as const;
  for (const [x, y] of paths) revealAround(map, mask, x, y, 180);
  for (const [x, y] of paths) assert.equal(isExplored(mask, cellIndexAt(map, x, y)), true);
  assert.ok(explorationPercent(map, mask) > 0);
});

test("wall line-of-sight prevents minimap exploration behind a closed wall", () => {
  const map = geometry(1_000, 600);
  map.wallSegments.push({ x1: 500, y1: 0, x2: 500, y2: 600 });
  const mask = createExplorationMask(map);
  revealAround(map, mask, 250, 300, 800);
  assert.equal(isExplored(mask, cellIndexAt(map, 750, 300)), false);
  assert.equal(isExplored(mask, cellIndexAt(map, 300, 300)), true);
});

test("large maps remain bounded to 256 cells per axis", () => {
  const grid = createMiniMapGrid({ x: -5_000, y: -2_000, width: 100_000, height: 200_000 });
  assert.ok(grid.columns <= 256);
  assert.ok(grid.rows <= 256);
  assert.ok(Math.ceil(grid.columns * grid.rows / 8) <= 8_192);
});

test("delta ranges are idempotent and reject out-of-bounds cells", () => {
  const map = geometry();
  const mask = createExplorationMask(map);
  const ranges = encodeCellRanges([1, 2, 3, 8, 9, 9]);
  assert.deepEqual(ranges, [[1, 3], [8, 2]]);
  assert.equal(applyCellRanges(mask, ranges, map.columns * map.rows), true);
  const before = [...mask];
  assert.equal(applyCellRanges(mask, ranges, map.columns * map.rows), true);
  assert.deepEqual([...mask], before);
  assert.equal(applyCellRanges(mask, [[map.columns * map.rows, 1]], map.columns * map.rows), false);
});
