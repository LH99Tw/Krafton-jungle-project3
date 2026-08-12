import assert from "node:assert/strict";
import test from "node:test";
import { resolveRoundGateProgress, resolveSharedPartyProgress } from "../src/game/domain/sharedPartyProgress";
import type { RoomMapCell } from "../src/game/domain/types";

const rooms: RoomMapCell[] = [
  { id: "z1-start", zone: 1, x: 0, y: 4, type: "start", visited: true, current: false, cleared: true, connections: [] },
  { id: "z1-gate", zone: 1, x: 4, y: 0, type: "gate", visited: true, current: false, cleared: true, connections: [] },
  { id: "z2-start", zone: 2, x: 0, y: 4, type: "start", visited: true, current: true, cleared: true, connections: [] },
];

test("derives map, gates, economy, experience, and base health only from shared party state", () => {
  const shared = resolveSharedPartyProgress({
    baseHp: 720,
    baseMaxHp: 900,
    gold: 145,
    currentZone: 2,
    teamLevel: 7,
    teamXp: 42,
    teamXpToNext: 80,
    rooms,
  });

  assert.deepEqual(shared, {
    baseHp: 720,
    baseMaxHp: 900,
    gold: 145,
    level: 7,
    xp: 42,
    xpToNext: 80,
    currentZone: 2,
    gatesDestroyed: 1,
    roomsExplored: 1,
    roomMap: rooms,
  });
});

test("derives the gate objective from the actual current-round gate state", () => {
  assert.deepEqual(resolveRoundGateProgress(1, rooms), { round: 1, destroyed: 1, goal: 1 });
  assert.deepEqual(resolveRoundGateProgress(2, rooms), { round: 2, destroyed: 0, goal: 1 });
  assert.deepEqual(resolveRoundGateProgress(3, rooms), { round: 3, destroyed: 0, goal: 1 });
});
