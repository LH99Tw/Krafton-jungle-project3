import assert from "node:assert/strict";
import test from "node:test";
import { generateZoneMap } from "@five-days/game-core";
import { buildRenderWorld, type RenderableRoom } from "../src/game/runtime/room/layout";
import {
  ROOM_DECOR_TEMPLATE_COUNT,
  ROOM_DECOR_TEMPLATES,
  selectRoomDecorTemplate,
} from "../src/game/runtime/room/roomDecorTemplates";

test("provides sixteen safe decoration templates for every zone", () => {
  for (const zone of [1, 2, 3] as const) {
    assert.equal(ROOM_DECOR_TEMPLATES[zone].length, ROOM_DECOR_TEMPLATE_COUNT);
    for (const template of ROOM_DECOR_TEMPLATES[zone]) {
      assert.ok(template.placements.length >= 6);
      for (const placement of template.placements) {
        assert.ok(placement.frame >= 0 && placement.frame < 16);
        assert.ok(placement.x < 0.2 || placement.x > 0.8 || placement.y < 0.2 || placement.y > 0.8,
          "decor must stay near room edges so it does not obscure combat");
      }
    }
  }
});

test("combines room type and run seed into a deterministic template choice", () => {
  const room: RenderableRoom = {
    id: "zone-1:2,2",
    zone: 1,
    x: 2,
    y: 2,
    type: "resource",
    connections: [],
  };
  assert.deepEqual(selectRoomDecorTemplate("run-a", room), selectRoomDecorTemplate("run-a", room));
  const choices = new Set(Array.from({ length: 32 }, (_, index) => selectRoomDecorTemplate(`run-${index}`, room).id));
  assert.ok(choices.size > 8, `expected broad template variation, received ${choices.size}`);
});

test("marks every non-room grid cell as blocked terrain", () => {
  const map = generateZoneMap("blocked-cells", 1);
  const rooms: RenderableRoom[] = map.rooms.map((room) => ({
    id: room.id,
    zone: room.zone,
    x: room.x,
    y: room.y,
    type: room.type,
    connections: room.connections,
  }));
  const world = buildRenderWorld(rooms, false);
  assert.equal(world.rooms.length, 15);
  assert.equal(world.blockedCells.length, 10);
});
