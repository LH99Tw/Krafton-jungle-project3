import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { GameCore, OFFICIAL_MAP_COMPILER_VERSION, OFFICIAL_MAP_MANIFEST, OFFICIAL_WORLD, officialMapRevisionPayload } from "../src/index";

test("official manifest revision covers compiler version, authored map, and compiled world", () => {
  const revision = crypto.createHash("sha256")
    .update(JSON.stringify(officialMapRevisionPayload(OFFICIAL_MAP_MANIFEST.map, OFFICIAL_MAP_MANIFEST.world)))
    .digest("hex");
  assert.equal(OFFICIAL_MAP_MANIFEST.schemaVersion, 1);
  assert.equal(OFFICIAL_MAP_MANIFEST.compilerVersion, OFFICIAL_MAP_COMPILER_VERSION);
  assert.equal(OFFICIAL_MAP_MANIFEST.mapRevision, revision);
});

test("official world starts at the authored base and connects through the boss", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "official-test", minimumPlayers: 1, world: OFFICIAL_WORLD });
  const player = core.addPlayer({ userId: "player", displayName: "Player", heroClass: "swordsman" });
  assert.equal(player.roomId, OFFICIAL_WORLD.baseRoomId);
  assert.equal(core.rooms.size, OFFICIAL_WORLD.rooms.length);
  const visited = new Set<string>([OFFICIAL_WORLD.baseRoomId]);
  const queue: string[] = [OFFICIAL_WORLD.baseRoomId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of OFFICIAL_WORLD.rooms.find((room) => room.id === current)?.connections ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  assert.equal(visited.has(OFFICIAL_WORLD.bossRoomId), true);
});

test("official monster-room enemies never leave their spawn room", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "official-static", minimumPlayers: 1, world: OFFICIAL_WORLD });
  const player = core.addPlayer({ userId: "player", displayName: "Player", heroClass: "swordsman" });
  core.setReady(player.userId, true);
  const monster = [...core.enemies.values()].find((enemy) => enemy.kind === "static")!;
  const spawnRoomId = monster.spawnRoomId;
  core.movePlayerToRoom(player.userId, spawnRoomId);
  for (let index = 0; index < 30; index += 1) core.update(0.1);
  assert.equal(monster.roomId, spawnRoomId);
  core.movePlayerToRoom(player.userId, OFFICIAL_WORLD.baseRoomId);
  for (let index = 0; index < 120; index += 1) core.update(0.1);
  assert.equal(monster.roomId, spawnRoomId);
  assert.ok(Math.hypot(monster.x - monster.spawnX, monster.y - monster.spawnY) < 1);
});

test("an undiscovered official gate spawns invaders that pathfind to and damage the base", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "official-invader", minimumPlayers: 1, world: OFFICIAL_WORLD });
  const player = core.addPlayer({ userId: "player", displayName: "Player", heroClass: "swordsman" });
  core.setReady(player.userId, true);
  core.setConnected(player.userId, false);
  const updateInvaderSpawning = (core as unknown as { updateInvaderSpawning(delta: number): void }).updateInvaderSpawning.bind(core);
  updateInvaderSpawning(60 / 8);
  const invader = [...core.enemies.values()].find((enemy) => enemy.kind === "invader")!;
  const gate = [...core.enemies.values()].find((enemy) => enemy.kind === "gate" && enemy.roomId === invader.spawnRoomId)!;
  assert.equal(core.rooms.get(gate.roomId)?.zone, 1);
  assert.equal(core.discoveredRooms.has(gate.roomId), false);
  assert.equal(invader.kind, "invader");
  assert.equal(invader.spawnRoomId, gate.roomId);
  assert.equal(invader.path[0], gate.roomId);
  assert.equal(invader.path.at(-1), OFFICIAL_WORLD.baseRoomId);
  assert.ok(invader.path.length > 1);

  const baseHp = core.baseHp;
  const updateInvaders = (core as unknown as { updateInvaders(delta: number): void }).updateInvaders.bind(core);
  // The official map may contain long, bent routes across many rooms. Give the
  // invader enough simulated time to traverse the authored path rather than
  // baking the previous six-room map's travel time into this assertion.
  for (let index = 0; index < 12_000 && invader.alive; index += 1) updateInvaders(0.1);
  assert.equal(invader.alive, false);
  assert.equal(invader.roomId, OFFICIAL_WORLD.baseRoomId);
  assert.ok(core.baseHp < baseHp);
});

test("advancing to zone two stops zone-one waves and only uses the zone-two gate", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "official-zone-waves", minimumPlayers: 1, world: OFFICIAL_WORLD });
  const player = core.addPlayer({ userId: "player", displayName: "Player", heroClass: "swordsman" });
  core.setReady(player.userId, true);
  const updateInvaderSpawning = (core as unknown as { updateInvaderSpawning(delta: number): void }).updateInvaderSpawning.bind(core);
  const waveInterval = 60 / 8;

  updateInvaderSpawning(waveInterval);
  const zoneOneInvaders = [...core.enemies.values()].filter((enemy) => enemy.kind === "invader");
  assert.ok(zoneOneInvaders.length > 0);
  assert.ok(zoneOneInvaders.every((enemy) => core.rooms.get(enemy.spawnRoomId)?.zone === 1));

  const zoneTwoRoom = OFFICIAL_WORLD.rooms.find((room) => room.zone === 2)!;
  core.movePlayerToRoom(player.userId, zoneTwoRoom.id);
  assert.equal(core.currentZone, 2);
  const previousIds = new Set(zoneOneInvaders.map((enemy) => enemy.id));
  updateInvaderSpawning(waveInterval);
  const zoneTwoInvaders = [...core.enemies.values()].filter((enemy) => enemy.kind === "invader" && !previousIds.has(enemy.id));
  assert.ok(zoneTwoInvaders.length > 0);
  assert.ok(zoneTwoInvaders.every((enemy) => core.rooms.get(enemy.spawnRoomId)?.zone === 2));

  core.movePlayerToRoom(player.userId, OFFICIAL_WORLD.baseRoomId);
  assert.equal(core.currentZone, 2, "progression must not fall back to zone one after returning to base");
  const beforeReturnWave = new Set([...core.enemies.keys()]);
  updateInvaderSpawning(waveInterval);
  const afterReturnWave = [...core.enemies.values()].filter((enemy) => enemy.kind === "invader" && !beforeReturnWave.has(enemy.id));
  assert.ok(afterReturnWave.length > 0);
  assert.ok(afterReturnWave.every((enemy) => core.rooms.get(enemy.spawnRoomId)?.zone === 2));
});

test("zone two remains locked with a warning until every zone-one gate is destroyed", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "official-zone-lock", minimumPlayers: 1, world: OFFICIAL_WORLD });
  const player = core.addPlayer({ userId: "player", displayName: "Player", heroClass: "swordsman" });
  core.setReady(player.userId, true);
  const transitionDoor = [...core.doors.values()].find((door) => {
    const zones = [core.rooms.get(door.fromRoomId)?.zone, core.rooms.get(door.toRoomId)?.zone];
    return zones.includes(1) && zones.includes(2);
  })!;
  const zoneOneSide = core.rooms.get(transitionDoor.fromRoomId)?.zone === 1
    ? transitionDoor.fromRoomId
    : transitionDoor.toRoomId;
  const zoneTwoSide = zoneOneSide === transitionDoor.fromRoomId ? transitionDoor.toRoomId : transitionDoor.fromRoomId;
  core.movePlayerToRoom(player.userId, zoneOneSide);

  assert.equal(core.interact(player.userId, transitionDoor.id), false);
  assert.equal(player.roomId, zoneOneSide);
  assert.deepEqual(core.takeNotices(), [{
    userId: player.userId,
    code: "ZONE_GATE_LOCKED",
    message: "구역 1의 게이트를 모두 파괴해야 다음 구역에 진입할 수 있습니다.",
  }]);

  for (const enemy of core.enemies.values()) {
    if (enemy.kind === "gate" && core.rooms.get(enemy.roomId)?.zone === 1) enemy.alive = false;
  }
  assert.equal(core.interact(player.userId, transitionDoor.id), true);
  assert.equal(player.roomId, zoneTwoSide);
  assert.equal(core.currentZone, 2);
});
