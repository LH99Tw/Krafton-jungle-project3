import assert from "node:assert/strict";
import test from "node:test";
import { GameCore, type AuthoredRoomId, type CoreWorldDefinition } from "../src/index";

const room = (id: string, kind: CoreWorldDefinition["rooms"][number]["kind"], zone: 1 | 2 | 3, x: number) => ({
  id: `editor:${id}` as AuthoredRoomId, zone, kind, rect: { x, y: 0, width: 1_000, height: 700 }, mapX: x / 1_000,
  mapY: 0, connections: [] as AuthoredRoomId[], depth: x / 1_000,
});

function specialWorld(): CoreWorldDefinition {
  const rooms = [room("start", "start", 1, 0), room("resource", "resource", 1, 1_200), room("shrine", "shrine", 1, 2_400),
    room("trap", "trap", 1, 3_600), room("checkpoint", "checkpoint", 2, 4_800), room("resource-two", "resource", 2, 6_000),
    room("altar", "altar", 3, 7_200), room("boss", "boss", 3, 8_400)];
  const ids = rooms.map((entry) => entry.id);
  return {
    kind: "authored", id: "special-test", rooms: rooms.map((entry, index) => ({ ...entry, connections: [ids[index - 1], ids[index + 1]].filter(Boolean) as AuthoredRoomId[] })),
    connections: [{
      id: "shrine-trap",
      from: "editor:shrine" as AuthoredRoomId,
      to: "editor:trap" as AuthoredRoomId,
      floorRects: [{ x: 3_400, y: 300, width: 200, height: 100 }],
      points: [{ x: 3_400, y: 350 }, { x: 3_600, y: 350 }],
      portal: { x: 3_500, y: 350 },
      lockBarrier: { x: 3_470, y: 300, width: 18, height: 100 },
      trapBarrier: { x: 3_570, y: 300, width: 18, height: 100 },
    }],
    walkable: rooms.map((entry) => entry.rect), bounds: { x: 0, y: 0, width: 9_400, height: 700 },
    baseRoomId: ids[0]!, bossRoomId: ids.at(-1)!, gateRoomIds: [],
  };
}

function setup(seed = "special") {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed, minimumPlayers: 1, world: specialWorld() });
  const player = core.addPlayer({ userId: "p1", displayName: "용사", heroClass: "swordsman" });
  core.setReady(player.userId, true);
  return { core, player };
}

test("resource caches grant deterministic personal equipment only once", () => {
  const first = setup("resource-seed");
  const second = setup("resource-seed");
  const resource = "editor:resource" as AuthoredRoomId;
  first.core.movePlayerToRoom("p1", resource);
  second.core.movePlayerToRoom("p1", resource);
  first.core.update(0.1);
  second.core.update(0.1);
  assert.deepEqual(first.player.equipment, second.player.equipment);
  assert.equal(first.core.rooms.get(resource)?.cleared, true);
  const equipment = structuredClone(first.player.equipment);
  const drops = [...first.core.drops.keys()];
  first.core.movePlayerToRoom("p1", "editor:start" as AuthoredRoomId);
  first.core.movePlayerToRoom("p1", resource);
  first.core.update(0.1);
  assert.deepEqual(first.player.equipment, equipment);
  assert.deepEqual([...first.core.drops.keys()], drops);
});

test("resource caches reward every party member once across reconnects", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "resource-party", minimumPlayers: 3, world: specialWorld() });
  const players = (["swordsman", "archer", "mage"] as const).map((heroClass, index) => (
    core.addPlayer({ userId: `p${index + 1}`, displayName: `P${index + 1}`, heroClass })
  ));
  for (const player of players) core.setReady(player.userId, true);
  const resource = "editor:resource" as AuthoredRoomId;
  core.movePlayerToRoom(players[0]!.userId, resource);
  core.update(0.1);

  const firstRewards = players.map((player) => ({
    equipment: structuredClone(player.equipment),
    inventory: structuredClone(player.inventory),
  }));
  assert.ok(players.every((player) => Object.values(player.equipment).some(Boolean) || player.inventory.some(Boolean)));

  core.setConnected(players[0]!.userId, false);
  core.setConnected(players[0]!.userId, true);
  core.movePlayerToRoom(players[0]!.userId, "editor:start" as AuthoredRoomId);
  core.movePlayerToRoom(players[0]!.userId, resource);
  core.update(0.1);
  assert.deepEqual(players.map((player) => ({ equipment: player.equipment, inventory: player.inventory })), firstRewards);
});

test("a full inventory leaves resource equipment on the floor until space is discarded", () => {
  const { core, player } = setup("resource-full-inventory");
  const filler = {
    id: "filler", ownerPlayerId: player.userId, zone: 1 as const, hiddenRoomId: "filler",
    dropIndex: 0, rarity: "legendary" as const, slot: "weapon" as const, statMultiplier: 1,
    specialOptionCount: 0 as const, attackPowerBonus: 1, armorHpBonus: 0, armorDefense: 0, accessoryAttackSpeed: 0,
  };
  player.equipment.weapon = filler;
  player.equipment.armor = { ...filler, id: "armor", slot: "armor" };
  player.equipment.accessory = { ...filler, id: "accessory", slot: "accessory" };
  player.inventory.fill(filler);
  const resource = "editor:resource" as AuthoredRoomId;
  core.movePlayerToRoom(player.userId, resource);
  core.update(0.1);
  const drop = [...core.drops.values()].find((candidate) => candidate.ownerPlayerId === player.userId);
  assert.ok(drop);
  assert.equal(core.equip(player.userId, drop.id), false);
  assert.ok(core.drops.has(drop.id));
  assert.equal(core.discardInventoryItem(player.userId, 0), true);
  assert.equal(core.equip(player.userId, drop.id), true);
  assert.equal(core.drops.has(drop.id), false);
});

test("inventory items can be discarded without a shop", () => {
  const { core, player } = setup("inventory-discard");
  core.movePlayerToRoom(player.userId, "editor:resource" as AuthoredRoomId);
  core.update(0.1);
  const item = Object.values(player.equipment).find((candidate) => candidate !== null);
  assert.ok(item);
  player.inventory[0] = item;
  assert.equal(core.discardInventoryItem(player.userId, 0), true);
  assert.equal(player.inventory[0], null);
  assert.equal(core.discardInventoryItem(player.userId, 0), false);
});

test("trap locks only its doorway and dynamically spawned monsters keep updating", () => {
  const { core, player } = setup("trap-motion");
  core.movePlayerToRoom(player.userId, "editor:trap" as AuthoredRoomId);
  player.x = 3_570;
  player.y = 350;
  core.update(0.1);
  assert.ok(player.x > 3_602, "entrant must be moved to the room side of the new doorway barrier");
  const barriers = (core as unknown as { lockedProgressionBarriers(): Array<{ x: number }> }).lockedProgressionBarriers();
  assert.deepEqual(barriers, [{ x: 3_570, y: 300, width: 18, height: 100 }]);
  for (let index = 0; index < 10; index += 1) core.update(0.1);
  const enemy = [...core.enemies.values()].find((candidate) => candidate.id.startsWith("enemy:trap:"));
  assert.ok(enemy);
  const before = { x: enemy.x, y: enemy.y };
  for (let index = 0; index < 10; index += 1) core.update(0.1);
  assert.notDeepEqual({ x: enemy.x, y: enemy.y }, before);
});

test("entering a higher zone clears an active previous-zone trap without spawning another wave", () => {
  const { core, player } = setup("trap-zone-cleanup");
  const trapRoomId = "editor:trap" as AuthoredRoomId;
  core.movePlayerToRoom(player.userId, trapRoomId);
  for (let index = 0; index < 11; index += 1) core.update(0.1);
  assert.ok([...core.enemies.values()].some((enemy) => enemy.alive && enemy.id.startsWith(`enemy:trap:${trapRoomId}:`)));

  core.movePlayerToRoom(player.userId, "editor:checkpoint" as AuthoredRoomId);
  for (let index = 0; index < 20; index += 1) core.update(0.1);

  assert.equal(core.currentZone, 2);
  assert.equal(core.specialRooms.get(trapRoomId)?.trapPhase, "cleared");
  assert.ok([...core.enemies.values()].filter((enemy) => enemy.spawnRoomId === trapRoomId).every((enemy) => !enemy.alive));
  const barriers = (core as unknown as { lockedProgressionBarriers(): Array<{ x: number }> }).lockedProgressionBarriers();
  assert.deepEqual(barriers, []);
});

test("altar enforces three personal attempts", () => {
  const { core, player } = setup("attempts");
  core.movePlayerToRoom(player.userId, "editor:altar" as AuthoredRoomId);
  for (let attempt = 0; attempt < 3; attempt += 1) assert.ok(core.rerollAltar(player.userId));
  assert.equal(core.rerollAltar(player.userId), null);
  assert.ok(Object.values(player.altarMultipliers).every((value) => value >= 0.5 && value <= 2));
});

test("discovered checkpoint waypoints provide three-second personal fast travel", () => {
  const { core, player } = setup("checkpoint-fast-travel");
  const checkpointRoomId = "editor:checkpoint" as AuthoredRoomId;
  const baseWaypoint = [...core.waypoints.values()].find((waypoint) => waypoint.kind === "start")!;
  const checkpointWaypoint = [...core.waypoints.values()].find((waypoint) => waypoint.kind === "checkpoint")!;

  assert.equal(baseWaypoint.active, true);
  assert.equal(checkpointWaypoint.active, false);
  assert.equal(core.requestTravel(player.userId, baseWaypoint.id, checkpointWaypoint.id), false, "unexplored destinations stay unavailable");

  core.movePlayerToRoom(player.userId, checkpointRoomId);
  assert.equal(checkpointWaypoint.active, true);
  assert.equal(core.requestTravel(player.userId, checkpointWaypoint.id, baseWaypoint.id), true);
  for (let index = 0; index < 29; index += 1) core.update(0.1);
  assert.equal(player.roomId, checkpointRoomId);
  core.update(0.1);
  assert.equal(player.roomId, baseWaypoint.roomId);
});

test("leaving a waypoint cancels personal fast travel", () => {
  const { core, player } = setup("checkpoint-fast-travel-cancel");
  const checkpointWaypoint = [...core.waypoints.values()].find((waypoint) => waypoint.kind === "checkpoint")!;
  const baseWaypoint = [...core.waypoints.values()].find((waypoint) => waypoint.kind === "start")!;
  core.movePlayerToRoom(player.userId, checkpointWaypoint.roomId);
  assert.equal(core.requestTravel(player.userId, checkpointWaypoint.id, baseWaypoint.id), true);
  core.update(1);
  player.x += 200;
  core.update(0.1);
  assert.equal(core.activeTravel, null);
  assert.equal(player.roomId, checkpointWaypoint.roomId);
});

test("shrine needs three seconds and waypoint rooms no longer replace the base respawn", () => {
  const { core, player } = setup("shrine-checkpoint");
  core.movePlayerToRoom(player.userId, "editor:shrine" as AuthoredRoomId);
  assert.equal(core.claimShrine(player.userId), true);
  for (let index = 0; index < 29; index += 1) core.update(0.1);
  assert.equal(player.shrineBuff, null);
  core.update(0.1);
  assert.ok(player.shrineBuff);
  core.movePlayerToRoom(player.userId, "editor:checkpoint" as AuthoredRoomId);
  assert.equal(core.setCheckpoint(player.userId), false);
  core.damagePlayer(player, 1_000_000);
  for (let index = 0; index < 49; index += 1) core.update(0.1);
  assert.equal(player.alive, false);
  core.update(0.1);
  assert.equal(player.alive, true);
  assert.equal(player.roomId, "editor:start");
});
