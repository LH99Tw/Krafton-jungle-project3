import assert from "node:assert/strict";
import test from "node:test";
import { GameCore, OFFICIAL_WORLD } from "../src/index";
import type { CoreWorldDefinition } from "../src/v02/simulation";
import {
  createWalkableSpatialIndex,
  findWalkableDiscPath,
  isWalkableDiscPoint,
  isWalkableDiscPointIndexed,
  resolveWalkableDiscPoint,
  type WorldRect,
} from "../src/v02/world";

test("the 256px spatial index is exactly equivalent to linear collision checks for 100,000 discs", () => {
  const index = createWalkableSpatialIndex(OFFICIAL_WORLD.walkable, 256);
  let randomState = 0x5eed_1234;
  const random = () => {
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    return randomState / 0x1_0000_0000;
  };
  const bounds = OFFICIAL_WORLD.bounds;
  for (let sample = 0; sample < 100_000; sample += 1) {
    const x = bounds.x - 64 + random() * (bounds.width + 128);
    const y = bounds.y - 64 + random() * (bounds.height + 128);
    const radius = random() * 32;
    assert.equal(
      isWalkableDiscPointIndexed(index, x, y, radius),
      isWalkableDiscPoint(OFFICIAL_WORLD.walkable, x, y, radius),
      `collision mismatch at sample ${sample}: (${x}, ${y}), radius ${radius}`,
    );
  }
});

test("disc pathfinding routes a distant follower around an L-shaped wall", () => {
  const walkable: readonly WorldRect[] = [
    { x: 0, y: 0, width: 320, height: 120 },
    { x: 200, y: 0, width: 120, height: 360 },
  ];
  const start = { x: 40, y: 60 };
  const target = { x: 260, y: 320 };
  const path = findWalkableDiscPath(walkable, start, target, 14, 32);

  assert.ok(path && path.length >= 2, "the route should contain a corner waypoint");
  let position = start;
  for (const waypoint of path) {
    for (let step = 0; step < 100 && Math.hypot(waypoint.x - position.x, waypoint.y - position.y) > 4; step += 1) {
      const dx = waypoint.x - position.x;
      const dy = waypoint.y - position.y;
      const distance = Math.hypot(dx, dy);
      position = resolveWalkableDiscPoint(
        walkable,
        position.x + dx / distance * Math.min(12, distance),
        position.y + dy / distance * Math.min(12, distance),
        position.x,
        position.y,
        14,
      );
    }
  }
  assert.ok(Math.hypot(target.x - position.x, target.y - position.y) <= 4);
});

test("a distant AI follower recovers through terrain when direct steering is blocked", () => {
  const startRoomId = "editor:start" as const;
  const targetRoomId = "editor:target" as const;
  const bossRoomId = "editor:boss" as const;
  const startRect = { x: 0, y: 240, width: 120, height: 120 };
  const targetRect = { x: 720, y: 240, width: 120, height: 120 };
  const bossRect = { x: 1_000, y: 0, width: 120, height: 120 };
  const connectionRects = [
    { x: 40, y: 80, width: 80, height: 200 },
    { x: 40, y: 40, width: 760, height: 80 },
    { x: 720, y: 80, width: 80, height: 200 },
  ] as const;
  const world: CoreWorldDefinition = {
    kind: "authored",
    id: "ai-recovery-test",
    rooms: [
      { id: startRoomId, zone: 1, kind: "start", rect: startRect, mapX: 0, mapY: 1, connections: [targetRoomId], depth: 0 },
      { id: targetRoomId, zone: 1, kind: "empty", rect: targetRect, mapX: 2, mapY: 1, connections: [startRoomId], depth: 1 },
      { id: bossRoomId, zone: 3, kind: "boss", rect: bossRect, mapX: 4, mapY: 0, connections: [], depth: 2 },
    ],
    connections: [{
      id: "u-bend",
      from: startRoomId,
      to: targetRoomId,
      floorRects: connectionRects,
      points: [],
      portal: { x: 720, y: 260 },
    }],
    walkable: [startRect, targetRect, bossRect, ...connectionRects],
    bounds: { x: 0, y: 0, width: 1_120, height: 360 },
    baseRoomId: startRoomId,
    bossRoomId,
    gateRoomIds: [],
  };
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "ai-recovery", minimumPlayers: 1, world });
  const human = core.addPlayer({ userId: "human", displayName: "용사", heroClass: "swordsman" });
  core.setReady(human.userId, true);
  core.addPlayer({ userId: "ai:defender", displayName: "수호자", heroClass: "swordsman" });
  const follower = core.addPlayer({ userId: "ai:follower", displayName: "동료", heroClass: "archer" });
  follower.x = 60;
  follower.y = 300;
  core.movePlayerToRoom(human.userId, targetRoomId);

  for (let step = 0; step < 300; step += 1) core.update(0.05);

  assert.equal(follower.roomId, targetRoomId, `follower stopped at ${follower.x},${follower.y}`);
  assert.ok(Math.hypot(human.x - follower.x, human.y - follower.y) <= 240);
});

test("an official-map follower does not oscillate when its leader retargets across a corridor", () => {
  const core = new GameCore({
    mode: "prototype",
    difficulty: "normal",
    seed: "official-follow-retarget",
    minimumPlayers: 1,
    world: OFFICIAL_WORLD,
  });
  const human = core.addPlayer({ userId: "human", displayName: "용사", heroClass: "swordsman" });
  core.setReady(human.userId, true);
  human.hp = 1_000_000;
  human.maxHp = 1_000_000;
  core.addPlayer({ userId: "ai:defender", displayName: "수호자", heroClass: "swordsman" });
  const follower = core.addPlayer({ userId: "ai:follower", displayName: "동료", heroClass: "archer" });
  follower.hp = 1_000_000;
  follower.maxHp = 1_000_000;

  const baseRoom = OFFICIAL_WORLD.rooms.find((room) => room.id === OFFICIAL_WORLD.baseRoomId)!;
  const corridorTarget = baseRoom.connections[0]!;
  core.movePlayerToRoom(human.userId, corridorTarget);
  for (let step = 0; step < 280; step += 1) core.update(0.05);
  assert.notEqual(follower.roomId, OFFICIAL_WORLD.baseRoomId, "the follower should leave the base before retargeting");

  core.movePlayerToRoom(human.userId, OFFICIAL_WORLD.baseRoomId);
  for (let step = 0; step < 500; step += 1) core.update(0.05);

  assert.equal(follower.roomId, OFFICIAL_WORLD.baseRoomId, `follower stopped at ${follower.x},${follower.y}`);
  assert.ok(Math.hypot(human.x - follower.x, human.y - follower.y) <= 240);
});

test("authored invaders choose the shorter bent corridor distance instead of the fewest rooms", () => {
  const gate = "editor:gate" as const;
  const shortA = "editor:short-a" as const;
  const shortB = "editor:short-b" as const;
  const long = "editor:long" as const;
  const base = "editor:base" as const;
  const boss = "editor:boss" as const;
  const rect = (x: number, y: number) => ({ x, y, width: 120, height: 120 });
  const rooms: CoreWorldDefinition["rooms"] = [
    { id: gate, zone: 1, kind: "gate", rect: rect(0, 0), mapX: 0, mapY: 0, connections: [long, shortA], depth: 3 },
    { id: shortA, zone: 1, kind: "empty", rect: rect(200, 0), mapX: 1, mapY: 0, connections: [gate, shortB], depth: 2 },
    { id: shortB, zone: 1, kind: "empty", rect: rect(400, 0), mapX: 2, mapY: 0, connections: [shortA, base], depth: 1 },
    { id: long, zone: 1, kind: "empty", rect: rect(0, 2_000), mapX: 0, mapY: 10, connections: [gate, base], depth: 1 },
    { id: base, zone: 1, kind: "start", rect: rect(600, 0), mapX: 3, mapY: 0, connections: [shortB, long], depth: 0 },
    { id: boss, zone: 3, kind: "boss", rect: rect(800, 0), mapX: 4, mapY: 0, connections: [], depth: 4 },
  ];
  const center = (roomId: typeof gate | typeof shortA | typeof shortB | typeof long | typeof base) => {
    const room = rooms.find((candidate) => candidate.id === roomId)!;
    return { x: room.rect.x + room.rect.width / 2, y: room.rect.y + room.rect.height / 2 };
  };
  const links = [
    [gate, long],
    [long, base],
    [gate, shortA],
    [shortA, shortB],
    [shortB, base],
  ] as const;
  const world: CoreWorldDefinition = {
    kind: "authored",
    id: "weighted-invader-route",
    rooms,
    connections: links.map(([from, to]) => ({
      id: `${from}-${to}`,
      from,
      to,
      floorRects: [],
      points: [center(from), center(to)],
      portal: center(to),
    })),
    walkable: rooms.map((room) => room.rect),
    bounds: { x: 0, y: 0, width: 920, height: 2_120 },
    baseRoomId: base,
    bossRoomId: boss,
    gateRoomIds: [gate],
  };
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "weighted-route", minimumPlayers: 1, world });

  assert.deepEqual(core.spawnInvader().path, [gate, shortA, shortB, base]);
});
