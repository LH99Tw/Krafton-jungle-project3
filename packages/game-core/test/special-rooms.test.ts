import assert from "node:assert/strict";
import test from "node:test";
import { GameCore, type AuthoredRoomId, type CoreWorldDefinition } from "../src/index";

const room = (id: string, kind: CoreWorldDefinition["rooms"][number]["kind"], zone: 1 | 2 | 3, x: number) => ({
  id: `editor:${id}` as AuthoredRoomId, zone, kind, rect: { x, y: 0, width: 1_000, height: 700 }, mapX: x / 1_000,
  mapY: 0, connections: [] as AuthoredRoomId[], depth: x / 1_000,
});

function specialWorld(): CoreWorldDefinition {
  const rooms = [room("start", "start", 1, 0), room("shop", "shop", 1, 1_200), room("shrine", "shrine", 1, 2_400),
    room("trap", "trap", 1, 3_600), room("checkpoint", "checkpoint", 2, 4_800), room("gamble", "gamble", 2, 6_000),
    room("altar", "altar", 3, 7_200), room("gold", "gold", 1, 8_400), room("boss", "boss", 3, 9_600)];
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
    walkable: rooms.map((entry) => entry.rect), bounds: { x: 0, y: 0, width: 10_600, height: 700 },
    baseRoomId: ids[0]!, bossRoomId: ids.at(-1)!, gateRoomIds: [],
  };
}

function setup(seed = "special") {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed, minimumPlayers: 1, world: specialWorld() });
  const player = core.addPlayer({ userId: "p1", displayName: "용사", heroClass: "swordsman" });
  core.setReady(player.userId, true);
  return { core, player };
}

test("shop stock is deterministic, personal, and shared gold never goes negative", () => {
  const first = setup("shop-seed");
  const second = setup("shop-seed");
  const shop = "editor:shop" as AuthoredRoomId;
  first.core.movePlayerToRoom("p1", shop);
  second.core.movePlayerToRoom("p1", shop);
  const left = first.core.getShopStock("p1", shop)!;
  const right = second.core.getShopStock("p1", shop)!;
  assert.deepEqual(left.offers, right.offers);
  first.core.gold = 0;
  assert.equal(first.core.shopBuy("p1", left.offers[0]!.id), false);
  assert.equal(first.core.gold, 0);
});

test("shop purchase works from the room center where its HUD first opens", () => {
  const { core, player } = setup("shop-center-purchase");
  const shop = "editor:shop" as AuthoredRoomId;
  core.movePlayerToRoom(player.userId, shop);
  const offer = core.getShopStock(player.userId, shop)!.offers.find((candidate) => candidate.kind === "equipment")!;
  core.gold = offer.price;

  assert.equal(core.shopBuy(player.userId, offer.id), true);
  assert.equal(core.gold, 0);
  assert.ok(player.inventory.some((item) => item?.id === offer.item?.id));
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

test("gamble and altar enforce three personal attempts", () => {
  const { core, player } = setup("attempts");
  core.gold = 10_000;
  core.movePlayerToRoom(player.userId, "editor:gamble" as AuthoredRoomId);
  for (let attempt = 0; attempt < 3; attempt += 1) assert.notEqual(core.playGamble(player.userId), null);
  assert.equal(core.playGamble(player.userId), null);
  core.movePlayerToRoom(player.userId, "editor:altar" as AuthoredRoomId);
  for (let attempt = 0; attempt < 3; attempt += 1) assert.ok(core.rerollAltar(player.userId));
  assert.equal(core.rerollAltar(player.userId), null);
  assert.ok(Object.values(player.altarMultipliers).every((value) => value >= 0.5 && value <= 2));
});

test("gold room awards shared gold once", () => {
  const { core, player } = setup("gold-room");
  core.movePlayerToRoom(player.userId, "editor:gold" as AuthoredRoomId);
  const before = core.gold;
  assert.equal(core.claimGoldRoom(player.userId), 100);
  assert.equal(core.gold, before + 100);
  assert.equal(core.claimGoldRoom(player.userId), null);
});

test("shrine needs three seconds and checkpoint respawns after five seconds", () => {
  const { core, player } = setup("shrine-checkpoint");
  core.movePlayerToRoom(player.userId, "editor:shrine" as AuthoredRoomId);
  assert.equal(core.claimShrine(player.userId), true);
  for (let index = 0; index < 29; index += 1) core.update(0.1);
  assert.equal(player.shrineBuff, null);
  core.update(0.1);
  assert.ok(player.shrineBuff);
  core.movePlayerToRoom(player.userId, "editor:checkpoint" as AuthoredRoomId);
  assert.equal(core.setCheckpoint(player.userId), true);
  core.damagePlayer(player, 1_000_000);
  for (let index = 0; index < 49; index += 1) core.update(0.1);
  assert.equal(player.alive, false);
  core.update(0.1);
  assert.equal(player.alive, true);
  assert.equal(player.roomId, "editor:checkpoint");
});
