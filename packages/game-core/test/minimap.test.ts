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
import type { MiniMapGeometry } from "@five-days/protocol";

function geometry(width = 2_000, height = 1_000): MiniMapGeometry {
  const bounds = { x: 0, y: 0, width, height };
  return {
    mapRevision: "test-map", areaId: "zone-1", bounds, ...createMiniMapGrid(bounds),
    surfaces: [rectToMiniMapSurface(bounds, "surface")], markers: [],
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
