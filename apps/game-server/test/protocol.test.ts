import assert from "node:assert/strict";
import test from "node:test";
import {
  PLAYER_VISION_RADIUS,
  PROTOCOL_VERSION,
  clientCommandSchema,
  combatActionEventSchema,
  inputFrameSchema,
  lobbyChatSchema,
  lobbyClassSelectSchema,
  lobbyCreateOptionsSchema,
  minimapDeltaSchema,
  minimapInitSchema,
  roomOptionsSchema,
  normalizePublicText,
  worldFrameSchema,
} from "@five-days/protocol";
import { OFFICIAL_MAP_MANIFEST } from "@five-days/game-core";
import { assertOfficialMapRevision, consumeGameTicket, partyPlayerIdsForView } from "../src/party-room";
import { GLOBAL_CHAT_HISTORY_LIMIT, retainRecentMessages } from "../src/global-chat-room";
import { take } from "../src/security";
import {
  DoorState,
  DropState,
  EnemyState,
  PartyRoomState,
  PlayerState,
  RoomState,
  StructureState,
  UpgradeChoiceState,
  WaypointState,
} from "../src/state";

test("rejects out-of-range player input", () => {
  const result = clientCommandSchema.safeParse({
    v: PROTOCOL_VERSION,
    type: "player.input",
    seq: 1,
    clientTime: 0,
    payload: { x: 99, y: 0, aim: 0, buttons: 0 },
  });
  assert.equal(result.success, false);
});

test("resolves protocol v10 room options and rejects easy or older clients", () => {
  const defaults = roomOptionsSchema.parse({
    heroClass: "swordsman",
    protocolVersion: PROTOCOL_VERSION,
    mapRevision: OFFICIAL_MAP_MANIFEST.mapRevision,
  });
  assert.equal(defaults.partyMode, "coop");
  assert.equal(defaults.sessionMode, "prototype");
  assert.equal(defaults.difficulty, "normal");

  const solo = roomOptionsSchema.parse({
    heroClass: "mage",
    sessionMode: "full",
    difficulty: "hard",
    partyMode: "solo",
    protocolVersion: PROTOCOL_VERSION,
    mapRevision: OFFICIAL_MAP_MANIFEST.mapRevision,
  });
  assert.equal(solo.partyMode, "solo");
  assert.equal(roomOptionsSchema.safeParse({ ...solo, difficulty: "easy" }).success, false);
  assert.equal(roomOptionsSchema.safeParse({ ...solo, protocolVersion: 1 }).success, false);
  assert.equal(roomOptionsSchema.safeParse({ ...solo, mapRevision: undefined }).success, false);
  assert.doesNotThrow(() => assertOfficialMapRevision(OFFICIAL_MAP_MANIFEST.mapRevision));
  assert.throws(() => assertOfficialMapRevision("outdated-map"), /MAP_REVISION_MISMATCH/);
});

test("accepts the v10 interaction, travel, recall, and equipment commands", () => {
  const base = { v: PROTOCOL_VERSION, seq: 7, clientTime: 12.5 } as const;
  const commands = [
    { ...base, type: "player.interact", payload: { targetId: "gate-zone-1" } },
    { ...base, type: "travel.request", payload: { waypointId: "wp-start", destinationId: "wp-center" } },
    { ...base, type: "recall.request", payload: {} },
    { ...base, type: "equipment.equip", payload: { dropId: "drop-mythic-1" } },
    { ...base, type: "equipment.inventory-discard", payload: { inventoryIndex: 0 } },
  ];

  for (const command of commands) assert.equal(clientCommandSchema.safeParse(command).success, true);
  for (const type of ["gold.claim", "gamble.play", "shop.buy"]) {
    assert.equal(clientCommandSchema.safeParse({ ...base, type, payload: {} }).success, false);
  }
});

test("strictly validates protocol v10 combat action events", () => {
  const event = {
    v: PROTOCOL_VERSION,
    sequence: 1,
    attackerId: "player-1",
    attackerType: "player",
    actionKind: "basic",
    heroClass: "archer",
    targetId: "invader-1",
    startX: 20,
    startY: 40,
    targetX: 120,
    targetY: 240,
    aim: Math.PI / 2,
    critical: true,
    patternKind: null,
    firedAt: 12.5,
  } as const;
  assert.equal(combatActionEventSchema.safeParse(event).success, true);
  assert.equal(combatActionEventSchema.safeParse({ ...event, targetX: Number.NaN }).success, false);
  assert.equal(combatActionEventSchema.safeParse({ ...event, v: 6 }).success, false);
});

test("strictly validates every command envelope and payload", () => {
  const valid = {
    v: PROTOCOL_VERSION,
    type: "player.interact",
    seq: 0,
    clientTime: 0,
    payload: { targetId: "resource-node" },
  } as const;
  assert.equal(clientCommandSchema.safeParse({ ...valid, seq: 0.5 }).success, false);
  assert.equal(clientCommandSchema.safeParse({ ...valid, clientTime: "now" }).success, false);
  assert.equal(clientCommandSchema.safeParse({ ...valid, v: 1 }).success, false);
  assert.equal(clientCommandSchema.safeParse({ ...valid, unexpected: true }).success, false);
  assert.equal(clientCommandSchema.safeParse({ ...valid, payload: { ...valid.payload, unexpected: true } }).success, false);
});

test("exposes the v10 room state graph through Colyseus schema collections", () => {
  const state = new PartyRoomState();
  state.seed = "seed-001";
  state.currentZone = 2;
  state.teamLevel = 10;
  state.teamXp = 25;
  state.teamXpToNext = 120;

  const player = new PlayerState();
  player.userId = "user-1";
  player.roomId = "zone-2-room-7";
  player.alive = true;
  player.attackSequence = 7;
  player.attackTargetId = "enemy-1";
  player.attackCritical = true;
  player.equipment.weaponId = "mythic-sword";
  player.upgradeDraft.active = true;
  player.upgradeDraft.draftId = "draft-1";
  const choice = new UpgradeChoiceState();
  choice.upgradeId = "power";
  player.upgradeDraft.choices.push(choice);
  state.players.set(player.userId, player);

  const room = new RoomState();
  room.id = player.roomId;
  state.rooms.set(room.id, room);
  const door = new DoorState();
  door.id = "door-1";
  state.doors.set(door.id, door);
  const enemy = new EnemyState();
  enemy.id = "enemy-1";
  state.enemies.set(enemy.id, enemy);
  const waypoint = new WaypointState();
  waypoint.id = "waypoint-1";
  waypoint.holdProgress = 0.5;
  state.waypoints.set(waypoint.id, waypoint);
  const structure = new StructureState();
  structure.id = "turret-1";
  state.structures.set(structure.id, structure);
  const drop = new DropState();
  drop.id = "drop-1";
  state.drops.set(drop.id, drop);

  assert.equal(state.protocolVersion, PROTOCOL_VERSION);
  assert.equal(state.players.get("user-1")?.equipment.weaponId, "mythic-sword");
  assert.equal(state.players.get("user-1")?.attackSequence, 7);
  assert.equal(state.players.get("user-1")?.attackCritical, true);
  assert.equal(state.players.get("user-1")?.attackTargetId, "enemy-1");
  assert.equal(state.players.get("user-1")?.upgradeDraft.choices.at(0)?.upgradeId, "power");
  assert.equal(state.rooms.size, 1);
  assert.equal(state.doors.size, 1);
  assert.equal(state.enemies.size, 1);
  assert.equal(state.waypoints.get("waypoint-1")?.holdProgress, 0.5);
  assert.equal(state.structures.size, 1);
  assert.equal(state.drops.size, 1);
});

test("validates v10 input and AOI world frames", () => {
  assert.equal(inputFrameSchema.safeParse({
    v: PROTOCOL_VERSION,
    seq: 4,
    clientTime: 12,
    x: 1,
    y: 0,
    aim: Math.PI,
    buttons: 0,
  }).success, true);
  assert.equal(worldFrameSchema.safeParse({
    v: PROTOCOL_VERSION,
    serverTick: 30,
    serverTime: Date.now(),
    ackInputSeq: 4,
    players: [{ id: "p1", roomId: "zone-1:0,0", x: 10, y: 20, vx: 1, vy: 0, aim: 0, flags: 0 }],
    enemies: [],
  }).success, true);
});

test("a capped 256-enemy AOI frame remains protocol-valid and bounded in size", () => {
  const frame = {
    v: PROTOCOL_VERSION,
    serverTick: 30,
    serverTime: Date.now(),
    ackInputSeq: 4,
    players: [{ id: "p1", roomId: "room", x: 10, y: 20, vx: 1, vy: 0, aim: 0, flags: 0 }],
    enemies: Array.from({ length: 256 }, (_, index) => ({
      id: `enemy-${index}`,
      roomId: "room",
      x: index,
      y: index,
      vx: 0,
      vy: 0,
      aim: 0,
      flags: 0,
    })),
  };
  assert.equal(worldFrameSchema.safeParse(frame).success, true);
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 40_000);
});

test("keeps every party member in each client state view", () => {
  const visible = partyPlayerIdsForView([
    { userId: "player-1", roomId: "zone-1:start" },
    { userId: "player-2", roomId: "zone-1:gate" },
    { userId: "player-3", roomId: "zone-2:start" },
  ]);
  assert.deepEqual([...visible], ["player-1", "player-2", "player-3"]);
});

test("bounds minimap geometry, masks, and delta ranges", () => {
  const geometry = {
    mapRevision: "map-1", areaId: "zone-1", bounds: { x: 0, y: 0, width: 1280, height: 720 },
    cellSize: 64, columns: 20, rows: 12,
    surfaces: [{ id: "room", points: [{ x: 0, y: 0 }, { x: 1280, y: 0 }, { x: 1280, y: 720 }, { x: 0, y: 720 }] }],
    wallSegments: [
      { x1: 0, y1: 0, x2: 1280, y2: 0 },
      { x1: 1280, y1: 0, x2: 1280, y2: 720 },
      { x1: 1280, y1: 720, x2: 0, y2: 720 },
      { x1: 0, y1: 720, x2: 0, y2: 0 },
    ],
    visionRadius: PLAYER_VISION_RADIUS,
    markers: [{ id: "gate", roomId: "gate-room", kind: "gate", label: "구역 게이트", x: 1100, y: 360, areaId: "zone-1", active: true }],
  } as const;
  assert.equal(minimapInitSchema.safeParse({ v: PROTOCOL_VERSION, geometry, revision: 0, explorationMask: "AAAA" }).success, true);
  assert.equal(minimapDeltaSchema.safeParse({ v: PROTOCOL_VERSION, mapRevision: "map-1", areaId: "zone-1", revision: 1, ranges: [[2, 4]] }).success, true);
  assert.equal(minimapDeltaSchema.safeParse({ v: PROTOCOL_VERSION, mapRevision: "map-1", areaId: "zone-1", revision: 1, ranges: [[65_535, 2]] }).success, false);
});

test("consumes each game ticket jti only once", async () => {
  const claims = { jti: crypto.randomUUID(), sub: crypto.randomUUID(), room: "party" as const };
  const consumed = new Set<string>();
  const atomicConsume = async ({ jti }: { jti: string; userId: string; room: "global_chat" | "lobby" | "party" }) => {
    if (consumed.has(jti)) return false;
    consumed.add(jti);
    return true;
  };
  assert.equal(await consumeGameTicket(claims, atomicConsume), true);
  assert.equal(await consumeGameTicket(claims, atomicConsume), false);
});

test("validates lobby creation, class selection, and chat payloads", () => {
  assert.equal(lobbyCreateOptionsSchema.safeParse({ roomName: "새벽 원정대", protocolVersion: PROTOCOL_VERSION }).success, true);
  assert.equal(lobbyCreateOptionsSchema.safeParse({ roomName: "x", protocolVersion: PROTOCOL_VERSION }).success, false);
  assert.equal(lobbyCreateOptionsSchema.safeParse({ roomName: "Legacy", difficulty: "easy", protocolVersion: PROTOCOL_VERSION }).success, false);
  assert.equal(lobbyClassSelectSchema.safeParse({ heroClass: null }).success, true);
  assert.equal(lobbyChatSchema.safeParse({ message: "원정 준비 완료" }).success, true);
  assert.equal(lobbyChatSchema.safeParse({ message: "x".repeat(181) }).success, false);
  assert.equal(lobbyChatSchema.safeParse({ message: "hello\u0000" }).success, false);
  assert.equal(normalizePublicText("  Ａ   B  "), "A B");
});

test("bounds in-memory connection rate buckets", () => {
  const key = `test-${crypto.randomUUID()}`;
  assert.equal(take(key, 2, 60_000, 1_000), true);
  assert.equal(take(key, 2, 60_000, 1_000), true);
  assert.equal(take(key, 2, 60_000, 1_000), false);
  assert.equal(take(key, 2, 60_000, 31_000), true);
});

test("global chat retains only the most recent messages", () => {
  const messages: number[] = [];
  for (let index = 0; index < GLOBAL_CHAT_HISTORY_LIMIT + 5; index += 1) {
    retainRecentMessages(messages, index);
  }
  assert.equal(messages.length, GLOBAL_CHAT_HISTORY_LIMIT);
  assert.equal(messages[0], 5);
  assert.equal(messages.at(-1), GLOBAL_CHAT_HISTORY_LIMIT + 4);
});
