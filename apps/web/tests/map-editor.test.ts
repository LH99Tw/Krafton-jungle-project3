import assert from "node:assert/strict";
import test from "node:test";
import { cloneEditorMap, DEFAULT_EDITOR_MAP, validateEditorMap } from "../src/game/domain/mapEditor";
import { buildEditorGeometry } from "../src/game/domain/editorGeometry";
import { buildEditorRenderWorld, clampToWalkable, clipWalkableLine, isWalkableDisc } from "../src/game/runtime/room/layout";

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

test("editor corridors are orthogonal and produce automatic wall openings", () => {
  const geometry = buildEditorGeometry(DEFAULT_EDITOR_MAP, { cellWidth: 320, cellHeight: 220, corridorWidth: 160 });
  assert.equal(geometry.routes.length, DEFAULT_EDITOR_MAP.connections.length);
  assert.ok(geometry.wallSegments.length > 0);
  for (const route of geometry.routes) {
    for (let index = 1; index < route.points.length; index += 1) {
      const from = route.points[index - 1]!;
      const to = route.points[index]!;
      assert.ok(from.x === to.x || from.y === to.y, "corridor segments must never be diagonal");
    }
  }
});

test("walls block movement and attacks while a connected corridor stays traversable", () => {
  const room = (id: string, x: number, connections: string[]) => ({ id, zone: 1, x, y: 0, width: 2, height: 2, type: id === "left" ? "start" as const : "empty" as const, connections });
  const disconnected = buildEditorRenderWorld([room("left", 0, []), room("right", 4, [])]);
  const disconnectedStart = disconnected.rooms.find((entry) => entry.room.id === "left")!.center;
  const disconnectedEnd = disconnected.rooms.find((entry) => entry.room.id === "right")!.center;
  const blockedMove = clampToWalkable(disconnected.walkable, disconnectedEnd.x, disconnectedEnd.y, disconnectedStart.x, disconnectedStart.y, 14);
  assert.ok(blockedMove.x < disconnectedEnd.x);
  assert.equal(clipWalkableLine(disconnected.walkable, disconnectedStart.x, disconnectedStart.y, disconnectedEnd.x, disconnectedEnd.y).clear, false);

  const connected = buildEditorRenderWorld([room("left", 0, ["right"]), room("right", 4, ["left"])]);
  const connectedStart = connected.rooms.find((entry) => entry.room.id === "left")!.center;
  const connectedEnd = connected.rooms.find((entry) => entry.room.id === "right")!.center;
  const corridorWaypoints = connected.corridors.map((rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }));
  const waypoints = [connectedStart, ...corridorWaypoints, connectedEnd];
  let position = waypoints[0]!;
  for (const waypoint of waypoints.slice(1)) {
    assert.equal(clipWalkableLine(connected.walkable, position.x, position.y, waypoint.x, waypoint.y).clear, true);
    position = clampToWalkable(connected.walkable, waypoint.x, waypoint.y, position.x, position.y, 14);
    assert.ok(Math.abs(position.x - waypoint.x) < 1 && Math.abs(position.y - waypoint.y) < 1);
  }
});

test("repeated physics frames cannot promote a position beyond a wall to the movement anchor", () => {
  const room = { id: "start", zone: 1, x: 0, y: 0, width: 2, height: 2, type: "start" as const, connections: [] };
  const world = buildEditorRenderWorld([room]);
  const rect = world.rooms[0]!.rect;
  let lastWalkable = { x: rect.x + rect.width - 15, y: rect.y + rect.height / 2 };

  for (let frame = 0; frame < 20; frame += 1) {
    const physicsPosition = { x: lastWalkable.x + 24, y: lastWalkable.y };
    lastWalkable = clampToWalkable(
      world.walkable,
      physicsPosition.x,
      physicsPosition.y,
      lastWalkable.x,
      lastWalkable.y,
      14,
    );
    assert.equal(isWalkableDisc(world.walkable, lastWalkable.x, lastWalkable.y, 14), true);
  }

  assert.ok(lastWalkable.x < rect.x + rect.width, "the player must remain inside the outer wall");
});

test("editor validation rejects overlapping rooms and duplicate corridors", () => {
  const map = cloneEditorMap(DEFAULT_EDITOR_MAP);
  map.rooms[1] = { ...map.rooms[1]!, x: map.rooms[0]!.x, y: map.rooms[0]!.y };
  map.connections.push({ ...map.connections[0]!, id: "duplicate" });
  const failures = validateEditorMap(map).join(" ");
  assert.match(failures, /겹칩니다/);
  assert.match(failures, /중복 통로/);
});

test("editor validation requires a wall-and-corridor gap between touching rooms", () => {
  const map = cloneEditorMap(DEFAULT_EDITOR_MAP);
  map.rooms[0] = { ...map.rooms[0]!, width: 4 };
  assert.match(validateEditorMap(map).join(" "), /통로용 한 칸/);
});
