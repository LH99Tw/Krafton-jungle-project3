import assert from "node:assert/strict";
import test from "node:test";
import { cloneEditorMap, DEFAULT_EDITOR_MAP, validateEditorMap } from "../src/game/domain/mapEditor";
import { buildEditorRenderWorld } from "../src/game/runtime/room/layout";

test("the bundled editor map is connected and playable", () => {
  assert.deepEqual(validateEditorMap(DEFAULT_EDITOR_MAP), []);
});

test("editor validation rejects a disconnected boss room", () => {
  const map = cloneEditorMap(DEFAULT_EDITOR_MAP);
  const boss = map.rooms.find((room) => room.type === "boss");
  assert.ok(boss);
  map.connections = map.connections.filter((connection) => connection.from !== boss.id && connection.to !== boss.id);
  assert.match(validateEditorMap(map).join(" "), /모든 방/);
});

test("editor room dimensions change the playable world rectangles", () => {
  const map = cloneEditorMap(DEFAULT_EDITOR_MAP);
  const rooms = map.rooms.map((room) => ({
    ...room,
    zone: room.asset === "forest" ? 1 : room.asset === "marsh" ? 2 : 3,
    connections: map.connections
      .filter((connection) => connection.from === room.id || connection.to === room.id)
      .map((connection) => connection.from === room.id ? connection.to : connection.from),
  })) as Parameters<typeof buildEditorRenderWorld>[0];
  const world = buildEditorRenderWorld(rooms);
  const boss = world.rooms.find((room) => room.room.type === "boss");
  assert.ok(boss);
  assert.equal(boss.rect.width, 4 * 320);
  assert.equal(boss.rect.height, 4 * 220);
  assert.ok(world.corridors.length >= map.connections.length);
});
