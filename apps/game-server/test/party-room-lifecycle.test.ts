import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@colyseus/core";
import { GameCore } from "@five-days/game-core";
import {
  INPUT_LEASE_MS,
  OperationTimeoutError,
  PartyRoom,
  createResultMessage,
  replaceSchemaArray,
  runWithTimeoutAndRetry,
} from "../src/party-room";
import { PROTOCOL_VERSION, transformFlags, type WorldFrame } from "@five-days/protocol";
import { PartyRoomState, SpecialRoomState } from "../src/state";
import {
  realtimeMetricsSnapshot,
  recordRoomInvaderMetrics,
  removeRoomInvaderMetrics,
} from "../src/realtime-metrics";

test("terminal result messages contain one complete final report", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "result-report", minimumPlayers: 1 });
  const player = core.addPlayer({ userId: "player-1", displayName: "Player", heroClass: "swordsman" });
  player.teamPower = 123;
  player.damage = 800;
  player.bossDamage = 500;
  player.kills = 12;
  core.finish("victory", "마왕 처치");

  assert.deepEqual(createResultMessage(core), {
    state: "victory",
    reason: "마왕 처치",
    elapsed: 0,
    day: 1,
    level: 1,
    teamPower: 123,
    stats: { damage: 800, bossDamage: 500, kills: 12, deaths: 0, structuresBuilt: 0, gatesDestroyed: 0 },
  });
});

test("bounded persistence retries use the configured backoff and stop after success", async () => {
  const attempts: number[] = [];
  const sleeps: number[] = [];
  const retries: Array<{ nextAttempt: number; delayMs: number }> = [];

  const result = await runWithTimeoutAndRetry(
    async (attempt) => {
      attempts.push(attempt);
      if (attempt < 3) throw new Error(`failure-${attempt}`);
      return "persisted";
    },
    {
      attemptTimeoutMs: 100,
      retryDelaysMs: [10, 20],
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
      onRetry: (_error, nextAttempt, delayMs) => {
        retries.push({ nextAttempt, delayMs });
      },
    },
  );

  assert.equal(result, "persisted");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(sleeps, [10, 20]);
  assert.deepEqual(retries, [
    { nextAttempt: 2, delayMs: 10 },
    { nextAttempt: 3, delayMs: 20 },
  ]);
});

test("bounded persistence retries time out and never exceed the configured attempt count", async () => {
  const attempts: number[] = [];

  await assert.rejects(
    runWithTimeoutAndRetry(
      async (attempt) => {
        attempts.push(attempt);
        return await new Promise<string>(() => undefined);
      },
      {
        attemptTimeoutMs: 5,
        retryDelaysMs: [0],
        sleep: async () => undefined,
      },
    ),
    (error: unknown) => (
      error instanceof OperationTimeoutError
      && error.attempt === 2
      && error.timeoutMs === 5
    ),
  );

  assert.deepEqual(attempts, [1, 2]);
});

test("a fresh active session wins a race against an older reserved reconnect", async () => {
  const connectedStates: boolean[] = [];
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  let initializedViews = 0;
  let syncCount = 0;

  const oldClient = {
    sessionId: "old-session",
    userData: { userId: "user-1" },
  } as unknown as Client;
  const replacement = {
    sessionId: "fresh-session",
    userData: { userId: "user-1" },
  } as unknown as Client;
  const reconnected = {
    sessionId: "old-session",
    userData: { userId: "user-1" },
    leave: (code?: number, reason?: string) => {
      closeCalls.push({ code, reason });
    },
  } as unknown as Client;

  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  const clients: Client[] = [];
  harness.clients = clients;
  harness.activeHumanSessions = new Set([oldClient.sessionId, replacement.sessionId]);
  harness.core = {
    setConnected: (_userId: string, connected: boolean) => {
      connectedStates.push(connected);
    },
  };
  harness.messageWindows = new Map();
  harness.inputMessageWindows = new Map();
  harness.reliableCommandSequences = new Map();
  harness.visibleEnemies = new Map();
  harness.visibleDrops = new Map();
  harness.visiblePlayerTransforms = new Map();
  harness.clientEnemyViewRevision = new Map();
  harness.syncState = () => {
    syncCount += 1;
  };
  harness.initializeClientView = () => {
    initializedViews += 1;
  };
  harness.allowReconnection = async () => {
    clients.push(replacement, reconnected);
    return reconnected;
  };

  await PartyRoom.prototype.onLeave.call(harness as unknown as PartyRoom, oldClient, false);

  assert.deepEqual(connectedStates, [false, true]);
  assert.deepEqual(closeCalls, [{ code: 4009, reason: "DUPLICATE_LOGIN" }]);
  assert.equal(initializedViews, 0);
  assert.equal(syncCount, 2);
});

test("a consented departure hands the existing character to server AI while a teammate remains", async () => {
  const takeoverCalls: string[] = [];
  const disconnectedStates: boolean[] = [];
  let syncCount = 0;
  const client = {
    sessionId: "leaving-session",
    userData: { userId: "user-1" },
  } as unknown as Client;
  const player = { userId: "user-1", connected: true, inputX: 1, inputY: -1 };
  const teammate = { userId: "user-2", connected: true, inputX: 0, inputY: 0 };
  const teammateClient = { sessionId: "remaining-session", userData: { userId: teammate.userId } } as unknown as Client;
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  harness.clients = [teammateClient];
  harness.activeHumanSessions = new Set([client.sessionId, teammateClient.sessionId]);
  harness.core = {
    players: new Map([[player.userId, player], [teammate.userId, teammate]]),
    takeOverPlayerWithAi: (userId: string) => {
      takeoverCalls.push(userId);
      return true;
    },
    setConnected: (_userId: string, connected: boolean) => disconnectedStates.push(connected),
    finish: () => undefined,
  };
  harness.messageWindows = new Map();
  harness.inputMessageWindows = new Map();
  harness.reliableCommandSequences = new Map();
  harness.visibleEnemies = new Map();
  harness.visibleDrops = new Map();
  harness.visiblePlayerTransforms = new Map();
  harness.clientEnemyViewRevision = new Map();
  harness.inputSequences = new Map([[player.userId, 4]]);
  harness.lastInputAt = new Map([[player.userId, Date.now()]]);
  harness.syncState = () => { syncCount += 1; };

  await PartyRoom.prototype.onLeave.call(harness as unknown as PartyRoom, client, true);

  assert.deepEqual(takeoverCalls, [player.userId]);
  assert.deepEqual(disconnectedStates, [false]);
  assert.equal(player.inputX, 0);
  assert.equal(player.inputY, 0);
  assert.equal(syncCount, 1);
});

test("the last consented player departure abandons and disposes the room instead of creating AI", async () => {
  const client = { sessionId: "last-session", userData: { userId: "user-1" } } as unknown as Client;
  const player = { userId: "user-1", connected: true, inputX: 1, inputY: 0 };
  let takeoverCalls = 0;
  let finalizeCalls = 0;
  let syncCount = 0;
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  harness.clients = [];
  harness.activeHumanSessions = new Set([client.sessionId]);
  harness.shutdownStarted = false;
  harness.core = {
    phase: "day",
    players: new Map([[player.userId, player]]),
    setConnected: (_userId: string, connected: boolean) => { player.connected = connected; },
    takeOverPlayerWithAi: () => { takeoverCalls += 1; return true; },
    finish: (_state: string, reason: string) => {
      (harness.core as { phase: string; resultReason?: string }).phase = "ended";
      (harness.core as { phase: string; resultReason?: string }).resultReason = reason;
    },
  };
  harness.messageWindows = new Map();
  harness.inputMessageWindows = new Map();
  harness.reliableCommandSequences = new Map();
  harness.visibleEnemies = new Map();
  harness.visibleDrops = new Map();
  harness.visiblePlayerTransforms = new Map();
  harness.clientEnemyViewRevision = new Map();
  harness.inputSequences = new Map();
  harness.lastInputAt = new Map();
  harness.syncState = () => { syncCount += 1; };
  harness.finalizeAndDisconnect = async () => { finalizeCalls += 1; };

  await PartyRoom.prototype.onLeave.call(harness as unknown as PartyRoom, client, true);

  assert.equal(takeoverCalls, 0);
  assert.equal(finalizeCalls, 1);
  assert.equal(syncCount, 1);
  assert.equal((harness.core as { phase: string }).phase, "ended");
  assert.equal((harness.core as { resultReason?: string }).resultReason, "모든 용사가 원정을 떠났습니다.");
});

test("an expired reconnect for the last player also disposes the room", async () => {
  const client = { sessionId: "lost-session", userData: { userId: "user-1" } } as unknown as Client;
  const player = { userId: "user-1", connected: true, inputX: 0, inputY: 0 };
  let finalizeCalls = 0;
  let takeoverCalls = 0;
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  harness.clients = [];
  harness.activeHumanSessions = new Set([client.sessionId]);
  harness.shutdownStarted = false;
  harness.core = {
    phase: "day",
    players: new Map([[player.userId, player]]),
    setConnected: (_userId: string, connected: boolean) => { player.connected = connected; },
    takeOverPlayerWithAi: () => { takeoverCalls += 1; return true; },
    finish: () => { (harness.core as { phase: string }).phase = "ended"; },
  };
  harness.messageWindows = new Map();
  harness.inputMessageWindows = new Map();
  harness.reliableCommandSequences = new Map();
  harness.visibleEnemies = new Map();
  harness.visibleDrops = new Map();
  harness.visiblePlayerTransforms = new Map();
  harness.clientEnemyViewRevision = new Map();
  harness.allowReconnection = async () => { throw new Error("reconnect expired"); };
  harness.syncState = () => undefined;
  harness.finalizeAndDisconnect = async () => { finalizeCalls += 1; };

  await PartyRoom.prototype.onLeave.call(harness as unknown as PartyRoom, client, false);

  assert.equal(takeoverCalls, 0);
  assert.equal(finalizeCalls, 1);
  assert.equal((harness.core as { phase: string }).phase, "ended");
});

test("ended-room shutdown disconnects even when result persistence fails", async (t) => {
  t.mock.method(console, "error", () => undefined);
  let disconnectCalls = 0;
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  harness.ensureResultPersisted = async () => {
    throw new Error("database unavailable");
  };
  harness.disconnect = async () => {
    disconnectCalls += 1;
  };

  const finalizeAndDisconnect = (
    PartyRoom.prototype as unknown as {
      finalizeAndDisconnect(this: PartyRoom): Promise<void>;
    }
  ).finalizeAndDisconnect;
  await finalizeAndDisconnect.call(harness as unknown as PartyRoom);

  assert.equal(disconnectCalls, 1);
});

test("input lease stops movement after a lost key-up frame", () => {
  const player = { userId: "user-1", inputX: 1, inputY: -1 };
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  harness.core = { players: new Map([[player.userId, player]]) };
  harness.lastInputAt = new Map([[player.userId, 1_000]]);
  const expire = (PartyRoom.prototype as unknown as {
    expireStaleInputs(this: PartyRoom, now: number): void;
  }).expireStaleInputs;
  expire.call(harness as unknown as PartyRoom, 1_000 + INPUT_LEASE_MS + 1);
  assert.equal(player.inputX, 0);
  assert.equal(player.inputY, 0);
});

test("input lease tolerates a short room-reveal rendering hitch", () => {
  const player = { userId: "user-1", inputX: 1, inputY: 0 };
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  harness.core = { players: new Map([[player.userId, player]]) };
  harness.lastInputAt = new Map([[player.userId, 1_000]]);
  const expire = (PartyRoom.prototype as unknown as {
    expireStaleInputs(this: PartyRoom, now: number): void;
  }).expireStaleInputs;
  expire.call(harness as unknown as PartyRoom, 1_200);
  assert.equal(player.inputX, 1);
});

test("special-room sync can add multiple trap participants to an empty ArraySchema", () => {
  const state = new SpecialRoomState();
  replaceSchemaArray(state.trapParticipants, ["p1", "p2", "p3"]);
  assert.deepEqual([...state.trapParticipants], ["p1", "p2", "p3"]);
  replaceSchemaArray(state.trapParticipants, ["p2"]);
  assert.deepEqual([...state.trapParticipants], ["p2"]);
});

test("schema sync removes retired enemies and their transform caches", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "schema-retirement", minimumPlayers: 1 });
  const invader = core.spawnInvader(1);
  core.discoveredRooms.add(invader.roomId);
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  harness.core = core;
  harness.state = new PartyRoomState();
  harness.clients = [];
  harness.visibleEnemies = new Map();
  harness.schemaRoomIds = new Map();
  harness.previousTransforms = new Map([[`enemy:${invader.id}`, { roomId: invader.roomId, x: invader.x, y: invader.y, at: 1 }]]);
  harness.lastEnemyFramePositions = new Map();
  harness.enemySchemaSnapshots = new Map();
  harness.lastKeyframeAt = 0;
  const syncState = (PartyRoom.prototype as unknown as { syncState(this: PartyRoom, force?: boolean): void }).syncState;

  syncState.call(harness as unknown as PartyRoom, true);
  assert.ok((harness.state as PartyRoomState).enemies.has(invader.id));
  invader.alive = false;
  (core as unknown as { retireInactiveInvaders(): void }).retireInactiveInvaders();
  syncState.call(harness as unknown as PartyRoom, true);

  assert.equal((harness.state as PartyRoomState).enemies.has(invader.id), false);
  assert.equal((harness.previousTransforms as Map<string, unknown>).has(`enemy:${invader.id}`), false);
  assert.equal((harness.schemaRoomIds as Map<string, unknown>).has(`enemy:${invader.id}`), false);
});

test("schema sync removes dead respawnable enemies until they are alive again", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "schema-corpse-cleanup", minimumPlayers: 1 });
  const enemy = [...core.enemies.values()].find((candidate) => candidate.kind === "static");
  assert.ok(enemy);
  core.discoveredRooms.add(enemy.roomId);
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  harness.core = core;
  harness.state = new PartyRoomState();
  harness.clients = [];
  harness.visibleEnemies = new Map();
  harness.schemaRoomIds = new Map();
  harness.previousTransforms = new Map();
  harness.lastEnemyFramePositions = new Map();
  harness.enemySchemaSnapshots = new Map();
  harness.lastKeyframeAt = 0;
  const syncState = (PartyRoom.prototype as unknown as { syncState(this: PartyRoom, force?: boolean): void }).syncState;

  syncState.call(harness as unknown as PartyRoom, true);
  assert.equal((harness.state as PartyRoomState).enemies.has(enemy.id), true);
  enemy.alive = false;
  enemy.hp = 0;
  syncState.call(harness as unknown as PartyRoom, true);
  assert.equal((harness.state as PartyRoomState).enemies.has(enemy.id), false);

  enemy.alive = true;
  enemy.hp = enemy.maxHp;
  syncState.call(harness as unknown as PartyRoom, true);
  assert.equal((harness.state as PartyRoomState).enemies.has(enemy.id), true);
});

test("party room keeps simulation at 60Hz while schema work is limited to 10Hz", () => {
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  let updates = 0;
  let syncs = 0;
  let viewUpdates = 0;
  Object.defineProperty(harness, "roomId", { value: "schema-rate-test" });
  harness.core = {
    phase: "day",
    players: new Map(),
    update: () => { updates += 1; },
    liveInvaderCount: 0,
    pendingInvaderCount: 0,
    invaderCapHitCount: 0,
    retiredInvaderCount: 0,
    invaderSimulationTiers: { hot: 0, warm: 0, cold: 0 },
    invaderWorkMetrics: { microSpawned: 0, pendingReplans: 0, completedReplans: 0, oldestPendingWaveSeconds: 0, combatAttackEvents: 0, compensatedAttacks: 0 },
    takeNotices: () => [],
    takeCombatActionEvents: () => [],
    setInvaderSchedulerEnabled: () => {},
  };
  harness.simulationAccumulatorMs = 0;
  harness.schemaSyncAccumulatorMs = 0;
  harness.explorationAccumulatorMs = 0;
  harness.serverTick = 0;
  harness.createdAt = Date.now();
  harness.gameplayLocked = true;
  harness.resultBroadcast = false;
  harness.shutdownStarted = false;
  harness.exploration = {
    update: () => undefined,
    takeGeometryUpdates: () => [],
    flush: () => [],
  };
  harness.expireStaleInputs = () => undefined;
  harness.syncState = () => { syncs += 1; };
  harness.updateClientViews = () => { viewUpdates += 1; };
  harness.emitWorldFrames = () => undefined;
  harness.broadcast = () => undefined;
  const simulate = (PartyRoom.prototype as unknown as { simulate(this: PartyRoom, deltaMs: number): void }).simulate;

  simulate.call(harness as unknown as PartyRoom, 17);
  simulate.call(harness as unknown as PartyRoom, 17);
  assert.equal(syncs, 0);
  simulate.call(harness as unknown as PartyRoom, 17);
  simulate.call(harness as unknown as PartyRoom, 17);
  simulate.call(harness as unknown as PartyRoom, 17);
  assert.equal(syncs, 0);
  simulate.call(harness as unknown as PartyRoom, 17);
  assert.equal(updates, 6);
  assert.equal(syncs, 1);
  assert.equal(viewUpdates, 1);
  removeRoomInvaderMetrics("schema-rate-test");
});

test("a delayed room tick compensates skipped combat time without replaying unlimited simulation ticks", () => {
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  let updates = 0;
  const compensated: number[] = [];
  const executionOrder: string[] = [];
  Object.defineProperty(harness, "roomId", { value: "lag-compensation-test" });
  harness.core = {
    phase: "day",
    players: new Map(),
    update: () => { updates += 1; executionOrder.push("simulation"); },
    compensateSkippedCombatTime: (delta: number) => { compensated.push(delta); executionOrder.push("combat"); return 1; },
    liveInvaderCount: 0,
    pendingInvaderCount: 0,
    invaderCapHitCount: 0,
    retiredInvaderCount: 0,
    invaderSimulationTiers: { hot: 0, warm: 0, cold: 0 },
    invaderWorkMetrics: { microSpawned: 0, pendingReplans: 0, completedReplans: 0, oldestPendingWaveSeconds: 0, combatAttackEvents: 0, compensatedAttacks: 1 },
    takeNotices: () => [],
    takeCombatActionEvents: () => [],
    setInvaderSchedulerEnabled: () => {},
  };
  harness.clients = [];
  harness.simulationAccumulatorMs = 0;
  harness.schemaSyncAccumulatorMs = 0;
  harness.explorationAccumulatorMs = 0;
  harness.serverTick = 0;
  harness.createdAt = Date.now();
  harness.gameplayLocked = true;
  harness.resultBroadcast = false;
  harness.shutdownStarted = false;
  harness.exploration = {
    update: () => undefined,
    takeGeometryUpdates: () => [],
    flush: () => [],
  };
  harness.expireStaleInputs = () => undefined;
  harness.syncState = () => undefined;
  harness.updateClientViews = () => undefined;
  harness.emitWorldFrames = () => undefined;
  harness.broadcast = () => undefined;
  const simulate = (PartyRoom.prototype as unknown as { simulate(this: PartyRoom, deltaMs: number): void }).simulate;

  simulate.call(harness as unknown as PartyRoom, 1_000);

  assert.equal(updates, 4);
  assert.equal(compensated.length, 1);
  assert.equal(executionOrder[0], "combat", "lag compensation must resolve combat before movement and enemy AI");
  assert.ok(Math.abs(compensated[0]! - 14 / 15) < 0.0001, "the omitted 56 ticks must advance combat clocks");
  removeRoomInvaderMetrics("lag-compensation-test");
});

test("realtime metrics expose bounded invader population and lifecycle counters", () => {
  const before = realtimeMetricsSnapshot() as { invaders: { active: number; pending: number; capHits: number; retired: number } };
  recordRoomInvaderMetrics("metrics-room", { active: 7, pending: 11, capHits: 2, retired: 3 });
  const during = realtimeMetricsSnapshot() as { invaders: { active: number; pending: number; capHits: number; retired: number } };
  assert.equal(during.invaders.active, before.invaders.active + 7);
  assert.equal(during.invaders.pending, before.invaders.pending + 11);
  assert.equal(during.invaders.capHits, before.invaders.capHits + 2);
  assert.equal(during.invaders.retired, before.invaders.retired + 3);
  removeRoomInvaderMetrics("metrics-room");
  const after = realtimeMetricsSnapshot() as { invaders: { active: number; pending: number } };
  assert.equal(after.invaders.active, before.invaders.active);
  assert.equal(after.invaders.pending, before.invaders.pending);
});

test("crossing into a connected room keeps a continuous transform while a real teleport snaps", () => {
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  const previousTransforms = new Map<string, { roomId: string; x: number; y: number; at: number }>();
  harness.previousTransforms = previousTransforms;
  const transformSample = (PartyRoom.prototype as unknown as {
    transformSample(
      this: PartyRoom,
      cacheKey: string,
      id: string,
      roomId: string,
      x: number,
      y: number,
      aim: number,
      serverTime: number,
    ): { flags: number; vx: number };
  }).transformSample;

  transformSample.call(harness as unknown as PartyRoom, "enemy:e1", "e1", "room-a", 100, 100, 0, 1_000);
  previousTransforms.set("enemy:e1", { roomId: "room-a", x: 100, y: 100, at: 1_000 });
  const doorwayCrossing = transformSample.call(harness as unknown as PartyRoom, "enemy:e1", "e1", "room-b", 103, 100, 0, 1_033);
  assert.equal(doorwayCrossing.flags, transformFlags.none);
  assert.ok(doorwayCrossing.vx > 0);

  previousTransforms.set("enemy:e1", { roomId: "room-b", x: 103, y: 100, at: 1_033 });
  const teleport = transformSample.call(harness as unknown as PartyRoom, "enemy:e1", "e1", "base", 500, 500, 0, 1_066);
  assert.equal(teleport.flags, transformFlags.discontinuity);
  assert.equal(teleport.vx, 0);
});

test("stopped transforms publish zero velocity and restart from the latest stationary sample", () => {
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  harness.previousTransforms = new Map();
  const transformSample = (PartyRoom.prototype as unknown as {
    transformSample(
      this: PartyRoom,
      cacheKey: string,
      id: string,
      roomId: string,
      x: number,
      y: number,
      aim: number,
      serverTime: number,
    ): { vx: number; vy: number };
  }).transformSample;

  transformSample.call(harness as unknown as PartyRoom, "player:ai", "ai", "base", 100, 100, 0, 1_000);
  const moving = transformSample.call(harness as unknown as PartyRoom, "player:ai", "ai", "base", 110, 100, 0, 1_100);
  const stopped = transformSample.call(harness as unknown as PartyRoom, "player:ai", "ai", "base", 110, 100, 0, 1_200);
  const restarted = transformSample.call(harness as unknown as PartyRoom, "player:ai", "ai", "base", 120, 100, 0, 1_300);

  assert.equal(moving.vx, 100);
  assert.equal(stopped.vx, 0);
  assert.equal(stopped.vy, 0);
  assert.equal(restarted.vx, 100, "stationary time must not dilute the resumed movement velocity");
});

test("world frames send enemy deltas and recover with a five-second keyframe", () => {
  const frames: WorldFrame[] = [];
  const player = { userId: "viewer", roomId: "room-a", x: 10, y: 10, aim: 0 };
  const enemy = { id: "enemy-1", roomId: "room-a", x: 20, y: 20 };
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  harness.core = {
    players: new Map([[player.userId, player]]),
    enemies: new Map([[enemy.id, enemy]]),
    discoveredRooms: new Set([enemy.roomId]),
  };
  harness.clients = [{
    sessionId: "session-1",
    userData: { userId: player.userId },
    send: (type: string, frame: WorldFrame) => { if (type === "world.frame") frames.push(frame); },
  }];
  harness.inputSequences = new Map();
  harness.previousTransforms = new Map();
  harness.lastEnemyFramePositions = new Map();
  harness.websocketSizeSamples = 0;
  harness.lastWebsocketFrameBytes = 0;
  harness.aoiRooms = () => new Set(["room-a"]);
  const emit = (PartyRoom.prototype as unknown as { emitWorldFrames(this: PartyRoom): void }).emitWorldFrames;

  harness.serverTick = 2;
  emit.call(harness as unknown as PartyRoom);
  harness.serverTick = 4;
  emit.call(harness as unknown as PartyRoom);
  harness.serverTick = 300;
  emit.call(harness as unknown as PartyRoom);

  assert.equal(frames[0]?.enemies.length, 1);
  assert.equal(frames[1]?.enemies.length, 0);
  assert.equal(frames[2]?.enemies.length, 1);
});

test("world frames publish enemy facing toward its current target", () => {
  const frames: WorldFrame[] = [];
  const player = { userId: "viewer", roomId: "room-a", x: 30, y: 20, aim: 0, alive: true };
  const enemy = {
    id: "enemy-1",
    roomId: "room-a",
    x: 20,
    y: 20,
    targetId: player.userId,
    transformRevision: 0,
  };
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  harness.core = {
    players: new Map([[player.userId, player]]),
    enemies: new Map([[enemy.id, enemy]]),
    discoveredRooms: new Set([enemy.roomId]),
  };
  harness.clients = [{
    sessionId: "session-1",
    userData: { userId: player.userId },
    send: (type: string, frame: WorldFrame) => { if (type === "world.frame") frames.push(frame); },
  }];
  harness.inputSequences = new Map();
  harness.previousTransforms = new Map();
  harness.lastEnemyFramePositions = new Map();
  harness.websocketSizeSamples = 0;
  harness.lastWebsocketFrameBytes = 0;
  harness.aoiRooms = () => new Set(["room-a"]);
  harness.serverTick = 2;

  const emit = (PartyRoom.prototype as unknown as { emitWorldFrames(this: PartyRoom): void }).emitWorldFrames;
  emit.call(harness as unknown as PartyRoom);

  assert.equal(frames[0]?.enemies[0]?.aim, 0);
  player.x = 20;
  player.y = 10;
  harness.serverTick = 4;
  emit.call(harness as unknown as PartyRoom);
  assert.equal(frames[1]?.enemies.length, 1, "a facing-only change must produce an enemy delta");
  assert.equal(frames[1]?.enemies[0]?.aim, -Math.PI / 2);
});

test("unreliable input sequence does not reject a reliable command", () => {
  const appliedInputs: number[] = [];
  let ready = false;
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  harness.core = {
    applyInput: (_userId: string, command: { seq: number }) => {
      appliedInputs.push(command.seq);
      return true;
    },
    setReady: () => {
      ready = true;
      return true;
    },
  };
  harness.inputSequences = new Map();
  harness.lastInputAt = new Map();
  harness.messageWindows = new Map();
  harness.reliableCommandSequences = new Map();
  const client = {
    sessionId: "session-1",
    userData: { userId: "user-1" },
    send: () => undefined,
  } as unknown as Client;
  const methods = PartyRoom.prototype as unknown as {
    applyInputFrame(this: PartyRoom, client: Client, frame: object): void;
    handleCommand(this: PartyRoom, client: Client, type: "room.ready", raw: object): void;
  };
  methods.applyInputFrame.call(harness as unknown as PartyRoom, client, {
    v: PROTOCOL_VERSION,
    seq: 100,
    clientTime: 0,
    x: 1,
    y: 0,
    aim: 0,
    buttons: 0,
  });
  methods.handleCommand.call(harness as unknown as PartyRoom, client, "room.ready", {
    v: PROTOCOL_VERSION,
    type: "room.ready",
    seq: 1,
    clientTime: 0,
    payload: { ready: true },
  });
  assert.deepEqual(appliedInputs, [100]);
  assert.equal(ready, true);
});

test("player AOI follows graph distance and crosses theme zones only in authored worlds", () => {
  const roomA = {
    id: "forest:0",
    zone: 1,
    gridX: 0,
    gridY: 0,
    connections: ["forest:1"],
  };
  const roomB = {
    id: "forest:1",
    zone: 1,
    gridX: 1,
    gridY: 0,
    connections: ["forest:0", "forest:1b"],
  };
  const roomB2 = {
    id: "forest:1b",
    zone: 1,
    gridX: 2,
    gridY: 0,
    connections: ["forest:1", "forest:1c"],
  };
  const roomB3 = {
    id: "forest:1c",
    zone: 1,
    gridX: 3,
    gridY: 0,
    connections: ["forest:1b"],
  };
  const roomC = {
    id: "forest:2",
    zone: 2,
    gridX: 0,
    gridY: 0,
    connections: [],
  };
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  harness.core = { rooms: new Map([[roomA.id, roomA], [roomB.id, roomB], [roomB2.id, roomB2], [roomB3.id, roomB3], [roomC.id, roomC]]) };
  const isPlayerInAoi = (PartyRoom.prototype as unknown as {
    isPlayerInAoi(
      this: PartyRoom,
      viewer: { roomId: string; x: number; y: number },
      candidate: { roomId: string; x: number; y: number },
    ): boolean;
  }).isPlayerInAoi;
  const viewer = { roomId: roomA.id, x: 640, y: 360 };

  assert.equal(isPlayerInAoi.call(harness as unknown as PartyRoom, viewer, {
    roomId: roomA.id,
    x: 200,
    y: 200,
  }), true);
  assert.equal(isPlayerInAoi.call(harness as unknown as PartyRoom, viewer, {
    roomId: roomB.id,
    x: 1_440,
    y: 360,
  }), true);
  assert.equal(isPlayerInAoi.call(harness as unknown as PartyRoom, viewer, {
    roomId: roomB.id,
    x: 9_000,
    y: 360,
  }), true);
  assert.equal(isPlayerInAoi.call(harness as unknown as PartyRoom, viewer, {
    roomId: roomB2.id,
    x: 20_000,
    y: 360,
  }), true);
  assert.equal(isPlayerInAoi.call(harness as unknown as PartyRoom, viewer, {
    roomId: roomB3.id,
    x: 640,
    y: 360,
  }), false);
  assert.equal(isPlayerInAoi.call(harness as unknown as PartyRoom, viewer, {
    roomId: roomC.id,
    x: 700,
    y: 360,
  }), false);

  roomA.connections.push(roomC.id);
  (harness.core as { options?: unknown }).options = { world: { id: "official-map" } };
  assert.equal(isPlayerInAoi.call(harness as unknown as PartyRoom, viewer, {
    roomId: roomC.id,
    x: 700,
    y: 360,
  }), true);
});
