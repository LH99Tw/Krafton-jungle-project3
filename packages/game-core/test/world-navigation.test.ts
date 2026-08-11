import assert from "node:assert/strict";
import test from "node:test";
import { GameCore } from "../src/index";
import type { CoreWorldDefinition } from "../src/v02/simulation";
import {
  findWalkableDiscPath,
  resolveWalkableDiscPoint,
  type WorldRect,
} from "../src/v02/world";

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
      { id: "start", zone: 1, kind: "start", rect: startRect, mapX: 0, mapY: 1, connections: ["target"], depth: 0 },
      { id: "target", zone: 1, kind: "empty", rect: targetRect, mapX: 2, mapY: 1, connections: ["start"], depth: 1 },
      { id: "boss", zone: 3, kind: "boss", rect: bossRect, mapX: 4, mapY: 0, connections: [], depth: 2 },
    ],
    connections: [{
      id: "u-bend",
      from: "start",
      to: "target",
      floorRects: connectionRects,
      points: [],
      portal: { x: 720, y: 260 },
    }],
    walkable: [startRect, targetRect, bossRect, ...connectionRects],
    bounds: { x: 0, y: 0, width: 1_120, height: 360 },
    baseRoomId: "start",
    bossRoomId: "boss",
    gateRoomIds: [],
  };
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "ai-recovery", minimumPlayers: 1, world });
  const human = core.addPlayer({ userId: "human", displayName: "용사", heroClass: "swordsman" });
  core.setReady(human.userId, true);
  core.addPlayer({ userId: "ai:defender", displayName: "수호자", heroClass: "swordsman" });
  const follower = core.addPlayer({ userId: "ai:follower", displayName: "동료", heroClass: "archer" });
  core.movePlayerToRoom(human.userId, "target");

  for (let step = 0; step < 300; step += 1) core.update(0.05);

  assert.equal(follower.roomId, "target", `follower stopped at ${follower.x},${follower.y}`);
  assert.ok(Math.hypot(human.x - follower.x, human.y - follower.y) <= 240);
});
