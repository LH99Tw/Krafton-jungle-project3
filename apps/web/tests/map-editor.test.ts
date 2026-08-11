import assert from "node:assert/strict";
import test from "node:test";
import { clampEditorPort, cloneEditorMap, DEFAULT_EDITOR_MAP, validateEditorMap, type EditorMapDefinition } from "../src/game/domain/mapEditor";
import { buildEditorGeometry, editorRoomPort } from "../src/game/domain/editorGeometry";
import { editorViewBox, fitEditorViewport, panEditorViewport, zoomEditorViewportAt } from "../src/game/domain/editorViewport";
import { buildEditorRenderWorld, clampToWalkable, clipWalkableLine, isWalkableDisc, wallEnvelopeRects } from "../src/game/runtime/room/layout";
import { GameCore } from "@five-days/game-core";
import { PROTOCOL_VERSION } from "@five-days/protocol";
import { LocalCoreSession } from "../src/features/map-editor/LocalCoreSession";
import { buildEditorCoreWorld } from "../src/features/map-editor/editorCoreWorld";
import {
  createStoredEditorMap,
  deleteStoredEditorMap,
  parseEditorMapLibrary,
  upsertStoredEditorMap,
} from "../src/game/domain/localMapLibrary";

test("the bundled editor map is connected and playable", () => {
  assert.deepEqual(validateEditorMap(DEFAULT_EDITOR_MAP), []);
});

test("local map library creates, updates, lists, and deletes independent maps", () => {
  const first = createStoredEditorMap("first", DEFAULT_EDITOR_MAP, 100);
  const secondMap = cloneEditorMap(DEFAULT_EDITOR_MAP);
  secondMap.title = "두 번째 맵";
  let maps = upsertStoredEditorMap([first], "second", secondMap, 200);
  assert.deepEqual(maps.map((record) => record.id), ["second", "first"]);

  secondMap.title = "수정된 맵";
  maps = upsertStoredEditorMap(maps, "second", secondMap, 300);
  assert.equal(maps[0]?.map.title, "수정된 맵");
  assert.equal(maps[0]?.createdAt, 200);
  assert.equal(maps[0]?.updatedAt, 300);

  const library = parseEditorMapLibrary(JSON.stringify({ version: 1, activeMapId: "second", maps }));
  assert.equal(library?.activeMapId, "second");
  assert.equal(library?.maps.length, 2);
  assert.deepEqual(deleteStoredEditorMap(maps, "second").map((record) => record.id), ["first"]);
});

test("editor playtest starts the authoritative three-class party", () => {
  const session = new LocalCoreSession();
  const snapshot = session.start(buildEditorCoreWorld(DEFAULT_EDITOR_MAP), "local-swordsman");
  assert.equal(snapshot.phase, "day");
  assert.deepEqual(snapshot.players.map((player) => player.heroClass), ["swordsman", "archer", "mage"]);
  assert.equal(snapshot.players.filter((player) => player.isLocal).length, 1);
  assert.equal(snapshot.players.filter((player) => player.userId.startsWith("ai:")).length, 2);
  session.stop();
});

test("local editor session advances the same GameCore result for the same fixed input", () => {
  const world = buildEditorCoreWorld(DEFAULT_EDITOR_MAP);
  const session = new LocalCoreSession();
  session.start(world, "same-user");
  const local = session.tick(1_000 / 60, { x: 1, y: 0, aim: 0, buttons: 0 }).snapshot;

  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: `editor-core:${world.id}`, minimumPlayers: 3, world });
  const party = [
    { userId: "same-user", displayName: "나", heroClass: "swordsman" as const },
    { userId: "ai:editor-defender", displayName: "루엔", heroClass: "archer" as const },
    { userId: "ai:editor-follower", displayName: "세라", heroClass: "mage" as const },
  ];
  for (const player of party) core.addPlayer(player);
  for (const player of party) core.setReady(player.userId, true);
  core.applyInput("same-user", {
    v: PROTOCOL_VERSION,
    type: "player.input",
    seq: 0,
    clientTime: 0,
    payload: { x: 1, y: 0, aim: 0, buttons: 0 },
  });
  core.update(1 / 60);

  const localPlayer = local.players.find((player) => player.userId === "same-user")!;
  const corePlayer = core.players.get("same-user")!;
  assert.equal(localPlayer.x, corePlayer.x);
  assert.equal(localPlayer.y, corePlayer.y);
  assert.equal(local.gold, core.gold);
  assert.equal(local.teamXp, core.teamXp);
  session.stop();
});

test("authoritative editor movement and dash cannot cross an exterior wall", () => {
  const world = buildEditorCoreWorld(DEFAULT_EDITOR_MAP);
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "editor-wall", minimumPlayers: 1, world });
  core.addPlayer({ userId: "wall-user", displayName: "나", heroClass: "swordsman" });
  core.setReady("wall-user", true);
  const start = world.rooms.find((room) => room.id === world.baseRoomId)!;
  core.applyInput("wall-user", {
    v: PROTOCOL_VERSION,
    type: "player.input",
    seq: 0,
    clientTime: 0,
    payload: { x: -1, y: 0, aim: Math.PI, buttons: 0 },
  });
  for (let index = 0; index < 300; index += 1) core.update(1 / 60);
  core.applyInput("wall-user", {
    v: PROTOCOL_VERSION,
    type: "player.input",
    seq: 1,
    clientTime: 1,
    payload: { x: -1, y: 0, aim: Math.PI, buttons: 4 },
  });
  const player = core.players.get("wall-user")!;
  assert.ok(player.x >= start.rect.x + 13.5, "actor radius must remain inside the generated wall");
  assert.equal(player.roomId, world.baseRoomId);
});

test("void rendering preserves exactly a half-tile wall envelope", () => {
  assert.deepEqual(wallEnvelopeRects([{ x: 100, y: 80, width: 320, height: 220 }]), [{
    x: 80,
    y: 60,
    width: 360,
    height: 260,
  }]);
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

test("editor validation rejects duplicate corridor ids and invalid room dimensions", () => {
  const map = cloneEditorMap(DEFAULT_EDITOR_MAP);
  map.connections[1] = { ...map.connections[1]!, id: map.connections[0]!.id };
  map.rooms[0] = { ...map.rooms[0]!, width: 0, height: 2.5 };
  const failures = validateEditorMap(map).join(" ");
  assert.match(failures, /통로 ID가 중복/);
  assert.match(failures, /방 크기/);
});

test("local map library drops records with malformed nested map fields", () => {
  const malformed = createStoredEditorMap("broken", DEFAULT_EDITOR_MAP, 100);
  (malformed.map.rooms[0] as unknown as { width: unknown }).width = "3";
  const valid = createStoredEditorMap("valid", DEFAULT_EDITOR_MAP, 200);
  const library = parseEditorMapLibrary(JSON.stringify({
    version: 1,
    activeMapId: "broken",
    maps: [malformed, valid],
  }));
  assert.equal(library?.activeMapId, "valid");
  assert.deepEqual(library?.maps.map((record) => record.id), ["valid"]);
});

test("editor validation requires a wall-and-corridor gap between touching rooms", () => {
  const map = cloneEditorMap(DEFAULT_EDITOR_MAP);
  map.rooms[0] = { ...map.rooms[0]!, width: 4 };
  assert.match(validateEditorMap(map).join(" "), /통로용 한 칸/);
});

test("negative room coordinates remain valid inside the 256-cell virtual canvas", () => {
  const map = cloneEditorMap(DEFAULT_EDITOR_MAP);
  map.rooms = map.rooms.map((room) => ({ ...room, x: room.x - 40, y: room.y - 30 }));
  assert.deepEqual(validateEditorMap(map), []);

  map.rooms[0] = { ...map.rooms[0]!, x: -129 };
  assert.match(validateEditorMap(map).join(" "), /-128\.\.127/);
});

test("explicit ports anchor the route exactly and shorten a corner-facing corridor", () => {
  const base: EditorMapDefinition = {
    version: 1,
    title: "port route",
    rooms: [
      { id: "left", name: "left", type: "start", asset: "forest", x: 0, y: 0, width: 6, height: 5 },
      { id: "right", name: "right", type: "boss", asset: "wastes", x: 8, y: 4, width: 6, height: 5 },
    ],
    connections: [{ id: "path", from: "left", to: "right" }],
  };
  const scale = { cellWidth: 50, cellHeight: 50, corridorWidth: 24 };
  const legacy = buildEditorGeometry(base, scale).routes[0]!;
  const explicit = cloneEditorMap(base);
  explicit.connections[0] = {
    ...explicit.connections[0]!,
    fromPort: { side: "east", offset: 4 },
    toPort: { side: "west", offset: 0 },
  };
  const route = buildEditorGeometry(explicit, scale).routes[0]!;
  const start = editorRoomPort(explicit.rooms[0]!, explicit.connections[0]!.fromPort!)!;
  const end = editorRoomPort(explicit.rooms[1]!, explicit.connections[0]!.toPort!)!;

  assert.deepEqual(route.points[0], { x: start.door.x * 50, y: start.door.y * 50 });
  assert.deepEqual(route.points.at(-1), { x: end.door.x * 50, y: end.door.y * 50 });
  assert.ok(route.length < legacy.length);
});

test("port offsets clamp after a room is shrunk and malformed ports are rejected", () => {
  const room = { id: "room", name: "room", type: "empty" as const, asset: "forest" as const, x: 0, y: 0, width: 2, height: 3 };
  assert.deepEqual(clampEditorPort(room, { side: "north", offset: 5 }), { side: "north", offset: 1 });

  const map = cloneEditorMap(DEFAULT_EDITOR_MAP);
  map.connections[0] = { ...map.connections[0]!, fromPort: { side: "north", offset: 99 } };
  assert.match(validateEditorMap(map).join(" "), /시작 출입구/);
});

test("runtime playtest preserves the editor connection endpoints", () => {
  const rooms = [
    { id: "left", zone: 1 as const, x: 0, y: 0, width: 6, height: 5, type: "start" as const, connections: ["right"] },
    { id: "right", zone: 3 as const, x: 8, y: 4, width: 6, height: 5, type: "boss" as const, connections: ["left"] },
  ];
  const connections = [{
    id: "path",
    from: "left",
    to: "right",
    fromPort: { side: "east" as const, offset: 4 },
    toPort: { side: "west" as const, offset: 0 },
  }];
  const world = buildEditorRenderWorld(rooms, connections);
  const left = world.rooms.find((entry) => entry.room.id === "left")!;
  const doorwayY = left.rect.y + 4.5 * 220;
  const doorwayX = left.rect.x + left.rect.width;
  const opening = world.corridors.find((rect) => (
    rect.x <= doorwayX && rect.x + rect.width >= doorwayX && rect.y <= doorwayY && rect.y + rect.height >= doorwayY
  ));
  assert.ok(opening, "playtest corridor must open at the selected east-side doorway");
  assert.equal(opening.y + opening.height / 2, doorwayY);
});

test("viewport zoom keeps the pointer world coordinate fixed and pan scales by zoom", () => {
  const initial = { centerX: 100, centerY: 50, zoom: 1 };
  const pointer = { x: 250, y: 140 };
  const before = editorViewBox(initial, 1_000, 600);
  const screenX = (pointer.x - before.x) * initial.zoom;
  const screenY = (pointer.y - before.y) * initial.zoom;
  const zoomed = zoomEditorViewportAt(initial, pointer, 2);
  const after = editorViewBox(zoomed, 1_000, 600);
  assert.equal((pointer.x - after.x) * zoomed.zoom, screenX);
  assert.equal((pointer.y - after.y) * zoomed.zoom, screenY);
  assert.deepEqual(panEditorViewport(zoomed, 40, -20), { ...zoomed, centerX: zoomed.centerX - 20, centerY: zoomed.centerY + 10 });
});

test("fit viewport centers all content with padding and respects zoom limits", () => {
  const fitted = fitEditorViewport({ x: -2_000, y: -1_000, width: 4_000, height: 2_000 }, 100, 1_000, 500);
  assert.equal(fitted.centerX, 0);
  assert.equal(fitted.centerY, 0);
  assert.ok(fitted.zoom >= 0.2 && fitted.zoom <= 2.5);
  const box = editorViewBox(fitted, 1_000, 500);
  assert.ok(box.x <= -2_000 && box.x + box.width >= 2_000);
  assert.ok(box.y <= -1_000 && box.y + box.height >= 1_000);
});
