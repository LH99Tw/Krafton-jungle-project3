import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION, type PlayerInputCommand } from "@five-days/protocol";
import {
  BOSS_ROOM_ID,
  buildWorldFromRooms,
  doorId,
  enemyPatternConfig,
  GameCore,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  roomWorldCenter,
  roomWorldRect,
  shortestRoomPath,
  shouldAiYieldEquipment,
  waypointId,
  type CoreEnemy,
  type PersonalHiddenDrop,
} from "../src/index";

test("constructs a deterministic authoritative world and starts players in the discovered base room", () => {
  const first = new GameCore({ mode: "prototype", difficulty: "normal", seed: "world-seed", minimumPlayers: 1 });
  const second = new GameCore({ mode: "prototype", difficulty: "normal", seed: "world-seed", minimumPlayers: 1 });
  assert.deepEqual(first.maps, second.maps);
  assert.deepEqual([...first.enemies.values()], [...second.enemies.values()]);
  assert.equal(first.rooms.size, 46);
  assert.ok(first.doors.size > 0);
  assert.equal(first.enemies.size, 21);
  assert.equal(first.waypoints.size, 9);

  const player = first.addPlayer({ userId: "p1", displayName: "용사", heroClass: "swordsman" });
  assert.equal(player.roomId, first.maps.zones[0].startRoomId);
  assert.equal(player.alive, true);
  assert.ok(first.discoveredRooms.has(player.roomId));
  assert.deepEqual(player.equipment, { weapon: null, armor: null, accessory: null });
});

test("keeps movement continuous and crosses only through a connecting corridor", () => {
  const core = startedCore("door-transition");
  const player = core.players.get("p1")!;
  const start = core.rooms.get(player.roomId)!;
  const right = [...core.rooms.values()].find((room) =>
    room.zone === 1 && room.gridX === start.gridX + 1 && room.gridY === start.gridY)!;
  assert.ok(start.connections.includes(right.id));

  const startRect = roomWorldRect({ x: start.gridX, y: start.gridY });
  // Walk east from the start-room edge through the corridor into the next room.
  player.x = startRect.x + ROOM_WIDTH - 2;
  player.y = startRect.y + ROOM_HEIGHT / 2;
  assert.equal(core.applyInput("p1", input(0, 1, 0)), true);
  for (let index = 0; index < 40; index += 1) core.update(0.1);
  assert.equal(player.roomId, right.id);
  assert.ok(player.x > startRect.x + ROOM_WIDTH, "player walked through the corridor into the next room");
  assert.ok(core.discoveredRooms.has(right.id));

  // An unconnected boundary clamps instead of leaving the room.
  player.x = startRect.x + ROOM_WIDTH / 2;
  player.y = startRect.y + ROOM_HEIGHT - 1;
  core.applyInput("p1", input(1, 0, 1));
  for (let index = 0; index < 40; index += 1) core.update(0.1);
  assert.equal(player.roomId, start.id, "an unconnected boundary must clamp instead of leaving");
  assert.ok(player.y <= startRect.y + ROOM_HEIGHT);
});

test("server auto attack picks the nearest enemy inside the cursor cone", () => {
  const core = startedCore("cone-target");
  const player = core.players.get("p1")!;
  player.x = 100;
  player.y = 100;
  player.aim = 0;
  const near = enemy("near", player.roomId, 190, 100);
  const far = enemy("far", player.roomId, 260, 100);
  const outsideCone = enemy("outside", player.roomId, 120, 240);
  core.enemies.clear();
  core.enemies.set(near.id, near);
  core.enemies.set(far.id, far);
  core.enemies.set(outsideCone.id, outsideCone);

  assert.equal(core.performAutoAttack("p1")?.id, near.id);
  assert.ok(near.hp < near.maxHp);
  assert.equal(near.aggroed, true);
  assert.equal(far.hp, far.maxHp);
  assert.equal(outsideCone.hp, outsideCone.maxHp);
});

test("server attacks across an open corridor but not through the surrounding wall", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "corridor-attack", minimumPlayers: 1 });
  const player = core.addPlayer({ userId: "p1", displayName: "궁수", heroClass: "archer" });
  core.setReady(player.userId, true);
  const start = core.rooms.get(player.roomId)!;
  const right = [...core.rooms.values()].find((room) => (
    room.zone === start.zone && room.gridX === start.gridX + 1 && room.gridY === start.gridY
  ))!;
  const startRect = roomWorldRect({ x: start.gridX, y: start.gridY });
  const rightRect = roomWorldRect({ x: right.gridX, y: right.gridY });
  player.x = startRect.x + startRect.width - 10;
  player.y = startRect.y + startRect.height / 2;
  player.aim = 0;

  const throughCorridor = enemy("through-corridor", right.id, rightRect.x + 10, player.y);
  const behindWall = enemy("behind-wall", right.id, rightRect.x + 10, rightRect.y + 100);
  core.enemies.clear();
  core.enemies.set(throughCorridor.id, throughCorridor);
  core.enemies.set(behindWall.id, behindWall);

  assert.equal(core.performAutoAttack(player.userId)?.id, throughCorridor.id);
  assert.ok(throughCorridor.hp < throughCorridor.maxHp);
  throughCorridor.alive = false;
  player.autoAttackCooldown = 0;
  player.aim = Math.atan2(behindWall.y - player.y, behindWall.x - player.x);
  assert.equal(core.performAutoAttack(player.userId), null);
  assert.equal(behindWall.hp, behindWall.maxHp);
});

test("static enemies chase, animate an attack sequence, and stay in their spawn room", () => {
  const core = startedCore("static-behavior");
  const player = core.players.get("p1")!;
  player.aim = Math.PI;
  const staticEnemy = enemy("static-test", player.roomId, player.x + 180, player.y);
  core.enemies.clear();
  core.enemies.set(staticEnemy.id, staticEnemy);
  const originalX = staticEnemy.x;
  core.update(0.1);
  assert.ok(staticEnemy.x < originalX);
  assert.equal(staticEnemy.aggroed, true);
  assert.equal(staticEnemy.patternPhase, "idle");
  player.x = staticEnemy.x - 20;
  for (let index = 0; index < 10; index += 1) core.update(0.1);
  assert.ok(staticEnemy.attackSequence > 0);
  assert.ok(player.hp < player.maxHp);
  const spawnRoomId = staticEnemy.spawnRoomId;
  const destination = core.rooms.get(player.roomId)!.connections[0]!;
  core.movePlayerToRoom(player.userId, destination);
  for (let index = 0; index < 20; index += 1) core.update(0.1);
  assert.equal(staticEnemy.roomId, spawnRoomId);
  assert.equal(staticEnemy.x, originalX);
  assert.equal(staticEnemy.patternPhase, "idle");
});

test("general and class augments affect authoritative attacks and skills", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "augment-runtime", minimumPlayers: 1 });
  const archer = core.addPlayer({ userId: "p1", displayName: "archer", heroClass: "archer" });
  core.setReady(archer.userId, true);
  archer.x = 100;
  archer.y = 100;
  archer.aim = 0;
  archer.upgrades = { multishot: 1, "archer-piercing": 1, "skill-power": 1, "skill-haste": 1, "archer-mark": 1 };
  core.enemies.clear();
  const targets = [150, 190, 230, 270].map((x, index) => enemy(`aug-${index}`, archer.roomId, x, 100));
  for (const target of targets) core.enemies.set(target.id, target);
  core.performAutoAttack(archer.userId);
  assert.ok(targets.slice(0, 4).every((target) => target.hp < target.maxHp), "multishot and piercing must damage additional targets");
  archer.autoAttackCooldown = 0;
  assert.equal(core.castSkill(archer.userId, "q", 0), true);
  assert.ok(archer.qCooldown > 0 && archer.qCooldown < 5, "skill haste must reduce authoritative cooldown");
});

test("elite pattern tiers increase from hidden to gate to boss", () => {
  const hidden = enemyPatternConfig("hidden");
  const gate = enemyPatternConfig("gate");
  const boss = enemyPatternConfig("boss");
  assert.ok(hidden.rayCount < gate.rayCount && gate.rayCount < boss.rayCount);
  assert.ok(hidden.floorCount < gate.floorCount && gate.floorCount < boss.floorCount);
  assert.ok(hidden.telegraphSeconds > gate.telegraphSeconds && gate.telegraphSeconds > boss.telegraphSeconds);
  assert.ok(hidden.cooldownSeconds > gate.cooldownSeconds && gate.cooldownSeconds > boss.cooldownSeconds);
  const core = startedCore("pattern-damage-tier");
  const hiddenEnemy = [...core.enemies.values()].find((enemy) => enemy.kind === "hidden")!;
  const gateEnemy = [...core.enemies.values()].find((enemy) => enemy.kind === "gate")!;
  core.day = 3;
  assert.equal(core.startBoss(), true);
  const bossEnemy = [...core.enemies.values()].find((enemy) => enemy.kind === "boss")!;
  assert.ok(hiddenEnemy.damage < gateEnemy.damage && gateEnemy.damage < bossEnemy.damage);
});

test("AI yields stronger non-exclusive equipment but keeps special mythic gear", () => {
  const base = {
    id: "ai-drop",
    ownerPlayerId: "ai:1",
    zone: 1 as const,
    hiddenRoomId: "zone-1:1,1" as const,
    dropIndex: 0,
    slot: "weapon" as const,
  };
  const legendary: PersonalHiddenDrop = { ...base, rarity: "legendary", statMultiplier: 0.8, specialOptionCount: 0 };
  const mythic: PersonalHiddenDrop = { ...base, id: "ai-mythic", rarity: "mythic", statMultiplier: 1, specialOptionCount: 2 };
  assert.equal(shouldAiYieldEquipment(legendary, null), true);
  assert.equal(shouldAiYieldEquipment(mythic, null), false);
  assert.equal(shouldAiYieldEquipment(legendary, legendary), false);
});

test("team XP creates personal deterministic drafts through milestone level 10", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "draft-integration", minimumPlayers: 2 });
  core.addPlayer({ userId: "p1", displayName: "검사", heroClass: "swordsman" });
  core.addPlayer({ userId: "p2", displayName: "궁수", heroClass: "archer" });
  while (core.teamLevel < 10) core.addTeamExperience(core.teamXpToNext - core.teamXp);
  assert.equal(core.teamLevel, 10);
  assert.equal(core.players.get("p1")?.level, 10);
  assert.equal(core.players.get("p2")?.level, 10);

  for (const player of core.players.values()) {
    const seenLevels: number[] = [];
    while (player.upgradeDraft) {
      const draft = player.upgradeDraft;
      seenLevels.push(draft.level);
      assert.equal(draft.choices.length, 3);
      if (draft.level === 10) assert.ok(draft.choices.every((choice) => choice.classId === player.heroClass));
      assert.equal(core.chooseUpgrade(player.userId, draft.draftId, draft.choices[0]!.id), true);
    }
    assert.deepEqual(seenLevels, [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  }
});

test("hidden-room kill awards deterministic personal legendary or mythic equipment", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "hidden-reward", minimumPlayers: 2 });
  const first = core.addPlayer({ userId: "p1", displayName: "검사", heroClass: "swordsman" });
  const second = core.addPlayer({ userId: "p2", displayName: "마법사", heroClass: "mage" });
  core.setReady(first.userId, true);
  core.setReady(second.userId, true);
  const hidden = [...core.enemies.values()].find((candidate) => candidate.kind === "hidden")!;
  core.movePlayerToRoom(first.userId, hidden.roomId, hidden.x - 20, hidden.y);
  core.movePlayerToRoom(second.userId, hidden.roomId, hidden.x - 30, hidden.y);
  assert.equal(core.damageEnemy(first.userId, hidden.id, hidden.hp), true);

  for (const player of [first, second]) {
    const equipped = Object.values(player.equipment).filter(Boolean);
    assert.equal(equipped.length, 1);
    assert.ok(equipped[0]!.rarity === "legendary" || equipped[0]!.rarity === "mythic");
    assert.equal(equipped[0]!.ownerPlayerId, player.userId);
  }
});

test("destroyed gates unlock a five-second all-player travel hold", () => {
  const core = twoPlayerCore("gate-travel");
  const gate = [...core.enemies.values()].find((candidate) => candidate.kind === "gate" && candidate.roomId.startsWith("zone-1:"))!;
  for (const player of core.players.values()) core.movePlayerToRoom(player.userId, gate.roomId, ROOM_WIDTH / 2, ROOM_HEIGHT / 2);
  assert.equal(core.damageEnemy("p1", gate.id, gate.hp), true);

  const sourceId = waypointId(gate.roomId as `zone-1:${number},${number}`, "gate");
  const source = core.waypoints.get(sourceId)!;
  assert.equal(source.active, true);
  assert.equal(core.waypoints.get(source.destinationId)?.active, true);
  assert.equal(core.requestTravel("p1", source.id, source.destinationId), true);
  for (let index = 0; index < 51; index += 1) core.update(0.1);
  assert.ok([...core.players.values()].every((player) => player.roomId === core.maps.zones[1].startRoomId));
  assert.equal(core.currentZone, 2);
  assert.equal(core.activeTravel, null);
});

test("zone three gate waypoint moves the whole connected party into the boss room", () => {
  const core = twoPlayerCore("boss-travel");
  const gate = [...core.enemies.values()].find((candidate) => candidate.kind === "gate" && candidate.roomId.startsWith("zone-3:"))!;
  for (const player of core.players.values()) core.movePlayerToRoom(player.userId, gate.roomId, ROOM_WIDTH / 2, ROOM_HEIGHT / 2);
  core.damageEnemy("p1", gate.id, gate.hp);
  const source = [...core.waypoints.values()].find((waypoint) => waypoint.roomId === gate.roomId)!;
  assert.equal(source.destinationId, BOSS_ROOM_ID);
  assert.equal(core.requestTravel("p1", source.id, BOSS_ROOM_ID), true);
  for (let index = 0; index < 51; index += 1) core.update(0.1);
  assert.equal(core.phase, "boss");
  assert.ok([...core.players.values()].every((player) => player.roomId === BOSS_ROOM_ID));
  assert.ok([...core.enemies.values()].some((candidate) => candidate.kind === "boss" && candidate.alive));
});

test("defender AI does not block travel while follower AI travels with the player", () => {
  const core = startedCore("ai-travel");
  const human = core.players.get("p1")!;
  const defender = core.addPlayer({ userId: "ai:defender", displayName: "guard", heroClass: "swordsman" });
  const follower = core.addPlayer({ userId: "ai:follower", displayName: "support", heroClass: "archer" });
  const gate = [...core.enemies.values()].find((candidate) => candidate.kind === "gate" && candidate.roomId.startsWith("zone-1:"))!;
  core.movePlayerToRoom(human.userId, gate.roomId);
  assert.equal(core.damageEnemy(human.userId, gate.id, gate.hp), true);
  const waypoint = [...core.waypoints.values()].find((candidate) => candidate.roomId === gate.roomId)!;
  assert.equal(core.requestTravel(human.userId, waypoint.id, waypoint.destinationId), true);
  for (let index = 0; index < 51; index += 1) core.update(0.1);
  assert.equal(human.roomId, core.maps.zones[1].startRoomId);
  assert.equal(follower.roomId, core.maps.zones[1].startRoomId);
  assert.equal(defender.roomId, core.maps.zones[0].startRoomId);
});

test("a defeated player immediately respawns at the base with full health and no stale movement", () => {
  const core = startedCore("player-respawn");
  const player = core.players.get("p1")!;
  core.movePlayerToRoom(player.userId, core.maps.zones[0].gateRoomId);
  player.inputX = 1;
  player.inputY = -1;
  player.lastButtons = 7;

  const damagePlayer = (core as unknown as {
    damagePlayer(target: typeof player, damage: number): void;
  }).damagePlayer.bind(core);
  damagePlayer(player, player.maxHp * 10);

  const baseRoom = core.rooms.get(core.maps.zones[0].startRoomId)!;
  const baseCenter = roomWorldCenter({ x: baseRoom.gridX, y: baseRoom.gridY });
  assert.equal(player.hp, player.maxHp);
  assert.equal(player.alive, true);
  assert.equal(player.roomId, baseRoom.id);
  assert.deepEqual({ x: player.x, y: player.y }, baseCenter);
  assert.equal(player.inputX, 0);
  assert.equal(player.inputY, 0);
  assert.equal(player.lastButtons, 0);
  assert.equal(player.deaths, 1);
  assert.notEqual(core.phase, "ended");
});

test("AI takeover preserves the departing character and reconnecting restores human control", () => {
  const core = startedCore("player-ai-takeover");
  const player = core.players.get("p1")!;
  player.teamPower = 321;
  player.damage = 456;
  (player.upgrades as Record<string, number>)["swordsman-blade"] = 3;
  const equipment = player.equipment;

  assert.equal(core.takeOverPlayerWithAi(player.userId), true);
  assert.equal(core.players.get(player.userId), player);
  assert.equal(player.connected, true);
  assert.ok(player.aiRole);
  assert.equal(player.teamPower, 321);
  assert.equal(player.damage, 456);
  assert.equal(player.upgrades["swordsman-blade"], 3);
  assert.equal(player.equipment, equipment);
  const target = [...core.enemies.values()].find((candidate) => candidate.alive)!;
  target.roomId = player.roomId;
  target.x = player.x + 20;
  target.y = player.y;
  const targetHp = target.hp;
  core.update(0.01);
  assert.ok(target.hp < targetHp, "the takeover AI should immediately participate in combat");

  const reclaimed = core.addPlayer({ userId: player.userId, displayName: player.displayName, heroClass: player.heroClass });
  assert.equal(reclaimed, player);
  assert.equal(reclaimed.aiRole, undefined);
  assert.equal(reclaimed.connected, true);
  assert.equal(reclaimed.teamPower, 321);
});

test("invaders physically traverse connected corridors and damage the base only after arrival", () => {
  const core = startedCore("invader-path");
  core.setConnected("p1", false);
  const invader = core.spawnInvader(1);
  invader.speed = 920;
  const firstRoom = invader.roomId;
  const firstPosition = { x: invader.x, y: invader.y };
  const baseBefore = core.baseHp;

  for (let index = 0; index < 300 && invader.roomId === firstRoom; index += 1) core.update(0.1);
  assert.notEqual(invader.roomId, firstRoom, "the invader should enter the next room using world movement");
  assert.ok(Math.hypot(invader.x - firstPosition.x, invader.y - firstPosition.y) > 100);
  assert.equal(invader.path[invader.pathIndex], invader.roomId);
  assert.equal(core.baseHp, baseBefore, "crossing an intermediate room must not damage the base");

  for (let index = 0; index < 1_500 && invader.alive; index += 1) core.update(0.1);
  assert.equal(invader.targetId, "base");
  assert.equal(invader.alive, false);
  assert.ok(core.baseHp < baseBefore);
});

test("invaders hand off from an upper-zone start to the previous-zone gate", () => {
  const core = startedCore("invader-zone-handoff");
  core.setConnected("p1", false);
  const invader = core.spawnInvader(3);
  invader.speed = 920;

  for (let index = 0; index < 1_000 && !invader.roomId.startsWith("zone-2:"); index += 1) core.update(0.1);
  assert.equal(invader.roomId, core.maps.zones[1].gateRoomId);
  assert.equal(invader.path[0], core.maps.zones[1].gateRoomId);
  assert.equal(invader.path.at(-1), core.maps.zones[1].startRoomId);
});

test("invader path selection is deterministic and occasionally chooses a route up to two hops longer", () => {
  const first = startedCore("route-determinism");
  const second = startedCore("route-determinism");
  assert.deepEqual(first.spawnInvader(1).path, second.spawnInvader(1).path);

  let foundLonger = false;
  for (let index = 0; index < 80; index += 1) {
    const core = startedCore(`route-random-${index}`);
    const invader = core.spawnInvader(1);
    const map = core.maps.zones[0];
    const shortest = shortestRoomPath(map, map.gateRoomId, map.startRoomId);
    assert.ok(invader.path.length <= shortest.length + 2);
    if (invader.path.length > shortest.length) foundLonger = true;
  }
  assert.equal(foundLonger, true, "seeded 20% routing should produce at least one valid detour");
});

test("gate invaders use 24 deterministic, non-overlapping spawn slots", () => {
  const first = startedCore("invader-spawn-slots");
  const second = startedCore("invader-spawn-slots");
  const firstPositions = Array.from({ length: 24 }, () => {
    const invader = first.spawnInvader(1);
    return `${invader.x.toFixed(3)},${invader.y.toFixed(3)}`;
  });
  const secondPositions = Array.from({ length: 24 }, () => {
    const invader = second.spawnInvader(1);
    return `${invader.x.toFixed(3)},${invader.y.toFixed(3)}`;
  });
  assert.equal(new Set(firstPositions).size, 24);
  assert.deepEqual(firstPositions, secondPositions);
});

test("at most six invaders engage one player while the rest continue toward the base", () => {
  const core = startedCore("invader-attacker-slots");
  const player = core.players.get("p1")!;
  const invaders = Array.from({ length: 12 }, () => core.spawnInvader(1));
  core.movePlayerToRoom(player.userId, invaders[0]!.roomId);
  player.hp = 10_000;
  player.maxHp = 10_000;
  for (const [index, invader] of invaders.entries()) {
    invader.x = player.x + 100 + index;
    invader.y = player.y;
  }
  core.update(0.01);
  assert.equal(invaders.filter((invader) => invader.targetId === player.userId).length, 6);
  assert.equal(invaders.filter((invader) => invader.targetId === "base").length, 6);
});

test("a 21-invader wave leaves its distributed gate slots without corridor deadlock", () => {
  const core = startedCore("invader-large-wave");
  core.setConnected("p1", false);
  const invaders = Array.from({ length: 21 }, () => core.spawnInvader(1));
  const starts = new Map(invaders.map((invader) => [invader.id, { x: invader.x, y: invader.y }]));
  for (let index = 0; index < 100; index += 1) core.update(0.1);
  for (const invader of invaders) {
    const start = starts.get(invader.id)!;
    assert.ok(!invader.alive || Math.hypot(invader.x - start.x, invader.y - start.y) > 100);
  }
});

test("invaders acquire, attack, and release nearby players with aggro hysteresis", () => {
  const core = startedCore("invader-aggro");
  const player = core.players.get("p1")!;
  const invader = core.spawnInvader(1);
  player.autoAttackCooldown = 999;
  core.movePlayerToRoom(player.userId, invader.roomId);
  player.x = invader.x + 30;
  player.y = invader.y;
  const hpBefore = player.hp;

  core.update(0.1);
  assert.equal(invader.targetId, player.userId);
  assert.ok(player.hp < hpBefore, "an invader in melee range should attack its player target");

  core.movePlayerToRoom(player.userId, core.maps.zones[0].startRoomId);
  core.update(0.1);
  assert.equal(invader.targetId, "base");
});

test("invaders replan instead of entering a newly locked connection", () => {
  const core = startedCore("invader-blocked-edge");
  core.setConnected("p1", false);
  const invader = core.spawnInvader(1);
  const blockedRoom = invader.path[1];
  assert.ok(blockedRoom);
  const blockedDoor = core.doors.get(doorId(invader.roomId as `zone-1:${number},${number}`, blockedRoom as `zone-1:${number},${number}`));
  assert.ok(blockedDoor);
  blockedDoor.locked = true;
  const before = { x: invader.x, y: invader.y };

  core.update(0.1);
  assert.notEqual(invader.path[1], blockedRoom, "the locked edge must be removed from the next route");
  assert.equal(invader.roomId, core.maps.zones[0].gateRoomId);
  const world = buildWorldFromRooms(
    [...core.rooms.values()].filter((room) => room.zone === 1 && room.id !== BOSS_ROOM_ID),
    false,
  );
  assert.ok(world.rects.some((rect) => (
    invader.x >= rect.x && invader.x < rect.x + rect.width && invader.y >= rect.y && invader.y < rect.y + rect.height
  )));
  assert.ok(Math.hypot(invader.x - before.x, invader.y - before.y) < 20, "replanning must not teleport through the wall");
});

test("stalled invaders blacklist the blocked edge and safely choose another route", () => {
  const core = startedCore("invader-blocked-edge");
  core.setConnected("p1", false);
  const invader = core.spawnInvader(1);
  const blockedRoom = invader.path[1];
  assert.ok(blockedRoom);
  invader.speed = 0;

  for (let index = 0; index < 9; index += 1) core.update(0.1);
  assert.notEqual(invader.path[1], blockedRoom);
  assert.equal(invader.roomId, core.maps.zones[0].gateRoomId);
  assert.equal(invader.x, invader.spawnX);
  assert.equal(invader.y, invader.spawnY);
});

test("each discovered resource room produces one shared gold every five simulation seconds", () => {
  const core = startedCore("resource-production");
  const player = core.players.get("p1")!;
  const resources = [...core.rooms.values()].filter((room) => room.kind === "resource");
  assert.ok(resources.length >= 2);
  core.movePlayerToRoom(player.userId, resources[0]!.id);
  const initialGold = core.gold;
  for (let index = 0; index < 49; index += 1) core.update(0.1);
  assert.equal(core.gold, initialGold);
  core.update(0.1);
  assert.equal(core.gold, initialGold + 1);

  core.movePlayerToRoom(player.userId, resources[1]!.id);
  for (let index = 0; index < 50; index += 1) core.update(0.1);
  assert.equal(core.gold, initialGold + 3, "two discovered resource rooms must produce independently");
});

test("normal static enemies respawn at their exact spawn after the mode-specific delay", () => {
  for (const [mode, delay] of [["prototype", 30], ["full", 90]] as const) {
    const core = new GameCore({ mode, difficulty: "normal", seed: `respawn-${mode}`, minimumPlayers: 1 });
    const player = core.addPlayer({ userId: "p1", displayName: "용사", heroClass: "swordsman" });
    core.setReady(player.userId, true);
    const target = [...core.enemies.values()].find((candidate) => candidate.kind === "static")!;
    core.movePlayerToRoom(player.userId, target.roomId, target.x - 10, target.y);
    core.damageEnemy(player.userId, target.id, target.hp);
    core.setConnected(player.userId, false);
    assert.equal(target.alive, false);
    assert.equal(core.rooms.get(target.spawnRoomId)?.cleared, true);
    for (let index = 0; index < delay * 10 - 1; index += 1) core.update(0.1);
    assert.equal(target.alive, false, `${mode} static enemy respawned too early`);
    core.update(0.1);
    assert.equal(target.alive, true);
    assert.equal(target.hp, target.maxHp);
    assert.equal(target.x, target.spawnX);
    assert.equal(target.y, target.spawnY);
    assert.equal(target.roomId, target.spawnRoomId);
    assert.equal(target.aggroed, false);
    assert.equal(target.targetId, null);
    assert.equal(core.rooms.get(target.spawnRoomId)?.cleared, false);
  }
});

test("hidden, gate, and boss enemies never respawn", () => {
  const core = startedCore("no-special-respawn");
  const player = core.players.get("p1")!;
  const targets = [...core.enemies.values()].filter((candidate) => candidate.kind === "hidden" || candidate.kind === "gate");
  assert.ok(targets.length > 0);
  for (const target of targets) {
    core.movePlayerToRoom(player.userId, target.roomId, target.x - 10, target.y);
    core.damageEnemy(player.userId, target.id, target.hp);
  }
  core.setConnected(player.userId, false);
  for (let index = 0; index < 1_000; index += 1) core.update(0.1);
  assert.ok(targets.every((target) => !target.alive && target.respawnRemaining === null));

  const bossCore = startedCore("no-boss-respawn");
  bossCore.day = 3;
  assert.equal(bossCore.startBoss(), true);
  const boss = [...bossCore.enemies.values()].find((candidate) => candidate.kind === "boss")!;
  bossCore.movePlayerToRoom("p1", BOSS_ROOM_ID, boss.x - 10, boss.y);
  bossCore.damageEnemy("p1", boss.id, boss.hp);
  assert.equal(bossCore.result, "victory");
  for (let index = 0; index < 1_000; index += 1) bossCore.update(0.1);
  assert.equal(boss.alive, false);
  assert.equal(boss.respawnRemaining, null);
});

test("recall uses the active waypoint and the existing five-second all-player quorum", () => {
  const core = twoPlayerCore("recall-quorum");
  const central = [...core.waypoints.values()].find((waypoint) => waypoint.zone === 1 && waypoint.kind === "central")!;
  core.movePlayerToRoom("p1", central.roomId, central.x, central.y);
  core.movePlayerToRoom("p2", central.roomId, central.x, central.y);
  assert.equal(central.active, true);
  assert.equal(core.recall("p1"), true);
  assert.equal(core.activeTravel?.destinationId, waypointId(core.maps.zones[0].startRoomId, "start"));
  for (let index = 0; index < 49; index += 1) core.update(0.1);
  assert.ok([...core.players.values()].every((player) => player.roomId === central.roomId));
  core.update(0.1);
  assert.ok([...core.players.values()].every((player) => player.roomId === core.maps.zones[0].startRoomId));
});

test("recall rejects a split quorum and allows returning from an unlocked gate waypoint", () => {
  const core = twoPlayerCore("recall-gate");
  const gate = [...core.enemies.values()].find((candidate) => candidate.kind === "gate" && candidate.roomId.startsWith("zone-1:"))!;
  core.movePlayerToRoom("p1", gate.roomId, ROOM_WIDTH / 2, ROOM_HEIGHT / 2);
  core.movePlayerToRoom("p2", gate.roomId, ROOM_WIDTH / 2, ROOM_HEIGHT / 2);
  core.damageEnemy("p1", gate.id, gate.hp);
  const gateWaypoint = [...core.waypoints.values()].find((waypoint) => waypoint.roomId === gate.roomId)!;
  core.movePlayerToRoom("p2", core.maps.zones[0].startRoomId);
  assert.equal(core.recall("p1"), false, "every connected alive player must occupy the same waypoint");
  core.movePlayerToRoom("p2", gate.roomId, gateWaypoint.x, gateWaypoint.y);
  assert.equal(core.recall("p1"), true);
  assert.equal(core.activeTravel?.destinationId, waypointId(core.maps.zones[0].startRoomId, "start"));
  for (let index = 0; index < 50; index += 1) core.update(0.1);
  assert.ok([...core.players.values()].every((player) => player.roomId === core.maps.zones[0].startRoomId));
});

test("hidden enemies attack players from range", () => {
  const core = startedCore("hidden-ranged");
  const player = core.players.get("p1")!;
  const hidden = [...core.enemies.values()].find((candidate) => candidate.kind === "hidden")!;
  core.movePlayerToRoom(player.userId, hidden.roomId);
  player.x = hidden.x;
  player.y = hidden.y;
  core.setConnected(player.userId, false);
  const hpBefore = player.hp;
  for (let index = 0; index < 60; index += 1) core.update(0.1);
  assert.ok(player.hp < hpBefore, "hidden enemy should damage the player over time");
});

test("boss pattern volley damages players inside the boss room", () => {
  const core = startedCore("boss-pattern");
  core.day = 3;
  assert.equal(core.startBoss(), true);
  const boss = [...core.enemies.values()].find((candidate) => candidate.kind === "boss")!;
  core.movePlayerToRoom("p1", BOSS_ROOM_ID);
  const hpBefore = core.players.get("p1")!.hp;
  for (let index = 0; index < 70; index += 1) core.update(0.1);
  assert.ok(core.players.get("p1")!.hp < hpBefore, "boss volley should damage the player");
  assert.equal(boss.alive, true);
});

test("a living gate spawns exactly 36 daytime and 120 nighttime invaders per phase", () => {
  const core = startedCore("day-spawn");
  for (let index = 0; index < 300; index += 1) core.update(0.1);
  assert.equal(
    [...core.enemies.values()].filter((candidate) => candidate.kind === "invader").length,
    10,
    "the first half of daytime should spawn only waves 1 through 4",
  );
  while (core.phase === "day") core.update(0.1);
  assert.equal(
    [...core.enemies.values()].filter((candidate) => candidate.kind === "invader").length,
    36,
    "a living gate should spawn 36 invaders during the full daytime phase",
  );
  for (let index = 0; index < 125; index += 1) core.update(0.1);
  assert.equal(
    [...core.enemies.values()].filter((candidate) => candidate.kind === "invader").length,
    71,
    "the first half of nighttime should add only 35 invaders",
  );
  while (core.phase === "night") core.update(0.1);
  assert.equal(
    [...core.enemies.values()].filter((candidate) => candidate.kind === "invader").length,
    156,
    "a living gate should add 120 invaders during the full nighttime phase",
  );
});

test("destroying the current-zone gate stops new spawns while existing invaders keep moving", () => {
  const core = startedCore("destroyed-gate-spawn");
  const player = core.players.get("p1")!;
  const invader = core.spawnInvader(1);
  const gate = [...core.enemies.values()].find((candidate) => candidate.kind === "gate" && candidate.roomId === core.maps.zones[0].gateRoomId)!;
  core.movePlayerToRoom(player.userId, gate.roomId);
  core.damageEnemy(player.userId, gate.id, gate.hp);
  core.setConnected(player.userId, false);
  const invaderCount = [...core.enemies.values()].filter((candidate) => candidate.kind === "invader").length;
  const before = { x: invader.x, y: invader.y };

  for (let index = 0; index < 200; index += 1) core.update(0.1);
  assert.equal([...core.enemies.values()].filter((candidate) => candidate.kind === "invader").length, invaderCount);
  assert.ok(Math.hypot(invader.x - before.x, invader.y - before.y) > 100, "an existing invader should continue after gate destruction");
});

test("solo AI companions: defender guards base, follower is driven toward the leader", () => {
  const core = startedCore("ai-follow");
  core.addPlayer({ userId: "ai:1", displayName: "수호자", heroClass: "swordsman" });
  core.addPlayer({ userId: "ai:2", displayName: "동행", heroClass: "archer" });
  const defender = core.players.get("ai:1")!;
  const follower = core.players.get("ai:2")!;
  const human = core.players.get("p1")!;
  assert.equal(defender.aiRole, "defender");
  assert.equal(follower.aiRole, "follower");
  while (core.teamLevel < 10) core.addTeamExperience(core.teamXpToNext - core.teamXp);
  for (const ai of [defender, follower]) {
    assert.equal(ai.level, 10);
    assert.equal(ai.upgradeDraft, null, "AI must automatically consume every pending draft");
    assert.equal(Object.values(ai.upgrades).reduce((sum, stacks) => sum + (stacks ?? 0), 0), 9);
    const milestoneId = Object.keys(ai.upgrades).find((id) => id.startsWith(`${ai.heroClass}-`));
    assert.ok(milestoneId, "AI must choose a class-compatible milestone augment");
  }

  core.movePlayerToRoom(human.userId, core.maps.zones[0].gateRoomId);
  const baseCenter = roomWorldCenter({ x: 0, y: 4 });
  const followerInitial = { x: follower.x, y: follower.y };
  for (let index = 0; index < 80; index += 1) core.update(0.1);
  const defenderNearBase = Math.hypot(defender.x - baseCenter.x, defender.y - baseCenter.y) < 400;
  const followerMoved = Math.hypot(follower.x - followerInitial.x, follower.y - followerInitial.y) > 1;
  const followerDriven = follower.inputX !== 0 || follower.inputY !== 0;
  assert.ok(defenderNearBase, "defender AI should guard the base room");
  assert.ok(followerMoved || followerDriven, "follower AI should be actively driven toward the leader");
});

test("follower AI keeps a wider trailing gap and resumes following beyond it", () => {
  const core = startedCore("ai-follow-gap");
  core.addPlayer({ userId: "ai:1", displayName: "수호자", heroClass: "swordsman" });
  const follower = core.addPlayer({ userId: "ai:2", displayName: "동행", heroClass: "archer" });
  const human = core.players.get("p1")!;

  follower.roomId = human.roomId;
  follower.x = human.x;
  follower.y = human.y;
  human.x += 160;
  core.update(0.01);
  assert.equal(follower.inputX, 0, "follower should hold position inside the wider trailing gap");

  human.x = follower.x + 220;
  core.update(0.01);
  assert.ok(follower.inputX > 0, "follower should resume moving when the leader exceeds the trailing gap");
});

function startedCore(seed: string): GameCore {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed, minimumPlayers: 1 });
  core.addPlayer({ userId: "p1", displayName: "용사", heroClass: "swordsman" });
  core.setReady("p1", true);
  return core;
}

function twoPlayerCore(seed: string): GameCore {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed, minimumPlayers: 2 });
  core.addPlayer({ userId: "p1", displayName: "검사", heroClass: "swordsman" });
  core.addPlayer({ userId: "p2", displayName: "궁수", heroClass: "archer" });
  core.setReady("p1", true);
  core.setReady("p2", true);
  return core;
}

function input(seq: number, x: number, y: number): PlayerInputCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "player.input" as const,
    seq,
    clientTime: seq,
    payload: { x, y, aim: 0, buttons: 0 },
  };
}

function enemy(id: string, roomId: CoreEnemy["roomId"], x: number, y: number): CoreEnemy {
  return {
    id,
    kind: "static",
    behavior: "static",
    roomId,
    spawnRoomId: roomId,
    x,
    y,
    spawnX: x,
    spawnY: y,
    hp: 100,
    maxHp: 100,
    damage: 1,
    speed: 70,
    attackRange: 30,
    attackCooldown: 0,
    xpReward: 0,
    goldReward: 0,
    alive: true,
    aggroed: false,
    targetId: null,
    lastHitBy: null,
    path: [],
    pathIndex: 0,
    coarseProgress: 0,
    respawnRemaining: null,
    patternKind: "fan",
    patternPhase: "idle",
    patternRemaining: 0,
    patternIndex: 0,
    attackSequence: 0,
  };
}
