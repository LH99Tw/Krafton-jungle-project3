import assert from "node:assert/strict";
import test from "node:test";
import {
  GameCore,
  OFFICIAL_WORLD,
  cellIndexAt,
  decodeMask,
  isExplored,
} from "@five-days/game-core";
import { PLAYER_VISION_RADIUS, minimapInitSchema } from "@five-days/protocol";
import { PartyExploration } from "../src/minimap";

test("official party exploration reveals discovered rooms and publishes category markers", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "official-minimap", minimumPlayers: 1, world: OFFICIAL_WORLD });
  const player = core.addPlayer({ userId: "player", displayName: "Player", heroClass: "swordsman" });
  const exploration = new PartyExploration(core);
  exploration.update();
  const init = exploration.allInit()[0]!;
  assert.equal(minimapInitSchema.safeParse(init).success, true);
  assert.equal(init.geometry.areaId, "official-map");
  assert.equal(init.geometry.visionRadius, PLAYER_VISION_RADIUS);
  assert.ok(init.geometry.wallSegments.length > 0);
  assert.ok(init.geometry.cellSize >= 32);
  assert.ok(init.geometry.columns <= 256);
  assert.ok(init.geometry.rows <= 256);
  const mask = decodeMask(init.explorationMask, Math.ceil(init.geometry.columns * init.geometry.rows / 8));
  assert.equal(isExplored(mask, cellIndexAt(init.geometry, player.x, player.y)), true);
  const boss = OFFICIAL_WORLD.rooms.find((room) => room.id === OFFICIAL_WORLD.bossRoomId)!;
  assert.equal(isExplored(mask, cellIndexAt(init.geometry, boss.rect.x + boss.rect.width / 2, boss.rect.y + boss.rect.height / 2)), false);
  const markers = new Set(init.geometry.markers.map((marker) => marker.kind));
  assert.ok(markers.has("resource"));
  assert.ok(markers.has("monster"));
  assert.ok(markers.has("elite"));
  assert.ok(markers.has("waypoint"));
  const delta = exploration.flush()[0]!;
  assert.equal(delta.areaId, "official-map");
  assert.ok(delta.ranges.length > 0);
});
