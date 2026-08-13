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

test("official map supports deterministic candidate gates or authored static gates", () => {
  const candidateCount = OFFICIAL_WORLD.gateCandidateRoomIds?.length ?? 0;
  const first = new GameCore({ mode: "prototype", difficulty: "normal", seed: "hex-gates", minimumPlayers: 1, world: OFFICIAL_WORLD });
  const repeat = new GameCore({ mode: "prototype", difficulty: "normal", seed: "hex-gates", minimumPlayers: 1, world: OFFICIAL_WORLD });
  const other = new GameCore({ mode: "prototype", difficulty: "normal", seed: "hex-gates-other", minimumPlayers: 1, world: OFFICIAL_WORLD });
  const gateRooms = (core: GameCore) => [...core.enemies.values()].filter((enemy) => enemy.kind === "gate").map((enemy) => enemy.roomId).sort();
  const selected = gateRooms(first);
  assert.equal(selected.length, candidateCount > 0 ? 9 : OFFICIAL_WORLD.gateRoomIds.length);
  assert.deepEqual(selected, gateRooms(repeat));
  if (candidateCount > 0) {
    assert.equal(candidateCount, 27);
    assert.notDeepEqual(selected, gateRooms(other));
    for (const zone of [1, 2, 3]) {
      assert.equal(selected.filter((roomId) => first.rooms.get(roomId)?.zone === zone).length, 3);
      assert.equal([...first.rooms.values()].filter((room) => room.zone === zone && room.kind === "static-monster").length >= 6, true);
    }
    assert.equal([...first.rooms.values()].filter((room) => room.kind === "gate-candidate").length, 0);
  } else {
    assert.deepEqual(selected, [...OFFICIAL_WORLD.gateRoomIds].sort());
    assert.deepEqual(selected, gateRooms(other), "authored static gates must not change with the run seed");
    for (const zone of [1, 2, 3]) assert.ok(selected.some((roomId) => first.rooms.get(roomId)?.zone === zone));
  }
});

test("official static map keeps the authored 2/3/3 gate layout", () => {
  assert.equal(OFFICIAL_WORLD.gateCandidateRoomIds?.length ?? 0, 0);
  const gateCounts = ([1, 2, 3] as const).map((zone) => OFFICIAL_WORLD.gateRoomIds.filter((roomId) => (
    OFFICIAL_WORLD.rooms.find((room) => room.id === roomId)?.zone === zone
  )).length);
  assert.deepEqual(gateCounts, [2, 3, 3]);
});

test("official authored zones contain playable rooms and remain connected", () => {
  const counts = new Map<number, number>();
  for (const room of OFFICIAL_WORLD.rooms) {
    if (room.kind === "boss" || room.kind === "altar") continue;
    counts.set(room.zone, (counts.get(room.zone) ?? 0) + 1);
  }
  assert.deepEqual([...counts.keys()], [1, 2, 3]);
  assert.ok([...counts.values()].every((count) => count > 0));
  assert.ok(OFFICIAL_WORLD.connections.length >= OFFICIAL_WORLD.rooms.length - 1);
});

test("official monster-room enemies never leave their spawn room", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "official-static", minimumPlayers: 1, world: OFFICIAL_WORLD });
  const player = core.addPlayer({ userId: "player", displayName: "Player", heroClass: "swordsman" });
  core.setReady(player.userId, true);
  const monster = [...core.enemies.values()].find((enemy) => enemy.kind === "static")!;
  monster.hp = monster.maxHp = 1_000_000;
  const spawnRoomId = monster.spawnRoomId;
  const originalSpawn = { x: monster.x, y: monster.y };
  core.movePlayerToRoom(player.userId, spawnRoomId);
  assert.ok(
    Math.hypot(monster.x - player.x, monster.y - player.y)
      >= Math.hypot(originalSpawn.x - player.x, originalSpawn.y - player.y),
    "discovering a compact legacy room must not move its enemy closer to player vision",
  );
  assert.deepEqual({ x: monster.spawnX, y: monster.spawnY }, { x: monster.x, y: monster.y });
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
  // The first wave is queued after ten seconds, then released through the
  // one-second micro-spawn scheduler instead of appearing all at once.
  for (let index = 0; index < 112; index += 1) core.update(0.1);
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
  const waveInterval = 20;

  for (let index = 0; index < 112; index += 1) core.update(0.1);
  const zoneOneInvaders = [...core.enemies.values()].filter((enemy) => enemy.kind === "invader");
  assert.ok(zoneOneInvaders.length > 0);
  assert.ok(zoneOneInvaders.every((enemy) => core.rooms.get(enemy.spawnRoomId)?.zone === 1));

  const zoneTwoRoom = OFFICIAL_WORLD.rooms.find((room) => room.zone === 2)!;
  core.movePlayerToRoom(player.userId, zoneTwoRoom.id);
  assert.equal(core.currentZone, 2);
  assert.ok(zoneOneInvaders.every((enemy) => !enemy.alive), "entering zone two must retire existing zone-one invaders");
  assert.ok([...core.enemies.values()].filter((enemy) => core.rooms.get(enemy.spawnRoomId)?.zone === 1).every((enemy) => !enemy.alive));
  const previousIds = new Set(zoneOneInvaders.map((enemy) => enemy.id));
  updateInvaderSpawning(waveInterval);
  updateInvaderSpawning(0.1);
  const zoneTwoInvaders = [...core.enemies.values()].filter((enemy) => enemy.kind === "invader" && !previousIds.has(enemy.id));
  assert.ok(zoneTwoInvaders.length > 0);
  assert.ok(zoneTwoInvaders.every((enemy) => core.rooms.get(enemy.spawnRoomId)?.zone === 2));

  core.movePlayerToRoom(player.userId, OFFICIAL_WORLD.baseRoomId);
  assert.equal(core.currentZone, 2, "progression must not fall back to zone one after returning to base");
  const beforeReturnWave = new Set([...core.enemies.keys()]);
  updateInvaderSpawning(waveInterval);
  updateInvaderSpawning(0.1);
  const afterReturnWave = [...core.enemies.values()].filter((enemy) => enemy.kind === "invader" && !beforeReturnWave.has(enemy.id));
  assert.ok(afterReturnWave.length > 0);
  assert.ok(afterReturnWave.every((enemy) => core.rooms.get(enemy.spawnRoomId)?.zone === 2));
});

test("the next zone keeps monsters and available special rooms active after previous-zone cleanup", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "official-open-zone-runtime", minimumPlayers: 1, world: OFFICIAL_WORLD });
  const player = core.addPlayer({ userId: "player", displayName: "Player", heroClass: "swordsman" });
  core.setReady(player.userId, true);
  const zoneOneEnemies = [...core.enemies.values()].filter((enemy) => core.rooms.get(enemy.spawnRoomId)?.zone === 1);
  const zoneTwoTrap = OFFICIAL_WORLD.rooms.find((room) => room.zone === 2 && room.kind === "trap");
  const zoneTwoDestination = zoneTwoTrap ?? OFFICIAL_WORLD.rooms.find((room) => room.zone === 2 && room.kind === "static-monster")!;

  core.movePlayerToRoom(player.userId, zoneTwoDestination.id);
  core.update(0.1);

  assert.equal(core.currentZone, 2);
  assert.ok(zoneOneEnemies.every((enemy) => !enemy.alive && enemy.respawnRemaining === null));
  if (zoneTwoTrap) assert.equal(core.specialRooms.get(zoneTwoTrap.id)?.trapPhase, "warning");

  for (let index = 0; index < 10; index += 1) core.update(0.1);
  if (zoneTwoTrap) {
    const trapEnemy = [...core.enemies.values()].find((enemy) => enemy.id.startsWith(`enemy:trap:${zoneTwoTrap.id}:`));
    assert.ok(trapEnemy?.alive, "the zone-two trap wave must continue simulating");
  } else {
    assert.ok([...core.enemies.values()].some((enemy) => enemy.alive && core.rooms.get(enemy.roomId)?.zone === 2));
  }
});

test("a mage follower respawn in zone two does not stall the shared simulation", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "zone-two-mage-respawn", minimumPlayers: 1, world: OFFICIAL_WORLD });
  const human = core.addPlayer({ userId: "human", displayName: "Player", heroClass: "swordsman" });
  core.setReady(human.userId, true);
  core.addPlayer({ userId: "ai:defender", displayName: "Defender", heroClass: "archer" });
  const mage = core.addPlayer({ userId: "ai:mage", displayName: "Mage", heroClass: "mage" });
  const zoneTwoTrap = OFFICIAL_WORLD.rooms.find((room) => room.zone === 2 && room.kind === "trap");
  const zoneTwoDestination = zoneTwoTrap ?? OFFICIAL_WORLD.rooms.find((room) => room.zone === 2 && room.kind === "static-monster")!;
  core.movePlayerToRoom(human.userId, zoneTwoDestination.id);
  core.movePlayerToRoom(mage.userId, zoneTwoDestination.id);
  human.hp = human.maxHp = 1_000_000;
  const humanPosition = { x: human.x, y: human.y };
  (core as unknown as { damagePlayer(player: typeof mage, damage: number): void }).damagePlayer(mage, mage.maxHp * 10);

  const elapsedBefore = core.elapsed;
  let slowestUpdateMs = 0;
  for (let index = 0; index < 60; index += 1) {
    const startedAt = performance.now();
    core.update(0.1);
    slowestUpdateMs = Math.max(slowestUpdateMs, performance.now() - startedAt);
  }

  assert.ok(core.elapsed >= elapsedBefore + 5.9, "the authoritative timer must keep advancing");
  assert.ok(slowestUpdateMs < 250, `mage recovery stalled a server tick for ${slowestUpdateMs.toFixed(1)}ms`);
  assert.deepEqual({ x: human.x, y: human.y }, humanPosition, "another player must not be relocated by the mage respawn");
  assert.equal(mage.alive, true);
  if (zoneTwoTrap) {
    assert.notEqual(core.specialRooms.get(zoneTwoTrap.id)?.trapPhase, "idle", "the zone-two special room must keep advancing");
    assert.ok([...core.enemies.values()].some((enemy) => enemy.alive && enemy.id.startsWith(`enemy:trap:${zoneTwoTrap.id}:`)), "zone-two monsters must keep updating");
  } else {
    assert.ok([...core.enemies.values()].some((enemy) => enemy.alive && core.rooms.get(enemy.roomId)?.zone === 2), "zone-two monsters must keep updating");
  }
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

test("walking into a locked open-field zone barrier emits the gate warning", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "official-zone-barrier-warning", minimumPlayers: 1, world: OFFICIAL_WORLD });
  const player = core.addPlayer({ userId: "player", displayName: "Player", heroClass: "swordsman" });
  core.setReady(player.userId, true);
  const connection = OFFICIAL_WORLD.connections.find((candidate) => {
    const from = OFFICIAL_WORLD.rooms.find((room) => room.id === candidate.from);
    const to = OFFICIAL_WORLD.rooms.find((room) => room.id === candidate.to);
    return from?.zone === 1 && to?.zone === 2 || from?.zone === 2 && to?.zone === 1;
  })!;
  const from = OFFICIAL_WORLD.rooms.find((room) => room.id === connection.from)!;
  const to = OFFICIAL_WORLD.rooms.find((room) => room.id === connection.to)!;
  const lower = from.zone === 1 ? from : to;
  const upper = lower === from ? to : from;
  const barrier = connection.lockBarrier!;
  const barrierCenter = { x: barrier.x + barrier.width / 2, y: barrier.y + barrier.height / 2 };
  const lowerCenter = { x: lower.rect.x + lower.rect.width / 2, y: lower.rect.y + lower.rect.height / 2 };
  const upperCenter = { x: upper.rect.x + upper.rect.width / 2, y: upper.rect.y + upper.rect.height / 2 };
  const distance = Math.hypot(upperCenter.x - lowerCenter.x, upperCenter.y - lowerCenter.y);
  const direction = { x: (upperCenter.x - lowerCenter.x) / distance, y: (upperCenter.y - lowerCenter.y) / distance };
  player.roomId = lower.id;
  player.x = barrierCenter.x - direction.x * 30;
  player.y = barrierCenter.y - direction.y * 30;

  const moved = (core as unknown as { movePlayer(player: unknown, x: number, y: number): boolean })
    .movePlayer(player, direction.x * 60, direction.y * 60);

  assert.equal(moved, false);
  assert.equal(player.roomId, lower.id);
  assert.deepEqual(core.takeNotices(), [{
    userId: player.userId,
    code: "ZONE_GATE_LOCKED",
    message: "구역 1의 게이트를 모두 파괴해야 다음 구역에 진입할 수 있습니다.",
  }]);
});
