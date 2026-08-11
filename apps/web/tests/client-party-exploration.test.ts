import assert from "node:assert/strict";
import test from "node:test";
import {
  createExplorationMask,
  createMiniMapGrid,
  isExplored,
  cellIndexAt,
  rectToMiniMapSurface,
} from "@five-days/game-core";
import { ClientPartyExploration } from "../src/game/netcode/ClientPartyExploration";
import { PLAYER_VISION_RADIUS, type MiniMapGeometry } from "@five-days/protocol";

test("party minimap exploration is calculated and retained by the browser", () => {
  const bounds = { x: 0, y: 0, width: 2_000, height: 640 };
  const geometry: MiniMapGeometry = {
    mapRevision: "client-map:v1",
    areaId: "official-map",
    bounds,
    ...createMiniMapGrid(bounds),
    surfaces: [rectToMiniMapSurface(bounds, "floor")],
    wallSegments: [],
    visionRadius: PLAYER_VISION_RADIUS,
    markers: [],
  };
  const minimap = { geometry, explorationMask: createExplorationMask(geometry), revision: 0 };
  const exploration = new ClientPartyExploration();

  const first = exploration.reveal(minimap, [{ id: "p1", roomId: "editor:base", x: 100, y: 100 }]);
  assert.ok(first > 0);
  assert.equal(isExplored(minimap.explorationMask, cellIndexAt(geometry, 100, 100)), true);
  assert.equal(exploration.reveal(minimap, [{ id: "p1", roomId: "editor:base", x: 102, y: 101 }]), 0);

  const second = exploration.reveal(minimap, [{ id: "p1", roomId: "editor:base", x: 1_500, y: 100 }]);
  assert.ok(second > 0);
  assert.equal(isExplored(minimap.explorationMask, cellIndexAt(geometry, 1_500, 100)), true);
});
