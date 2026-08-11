import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@colyseus/core";
import {
  INPUT_LEASE_MS,
  OperationTimeoutError,
  PartyRoom,
  runWithTimeoutAndRetry,
} from "../src/party-room";
import { PROTOCOL_VERSION, transformFlags } from "@five-days/protocol";

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

test("a consented departure hands the existing character to server AI", async () => {
  const takeoverCalls: string[] = [];
  const disconnectedStates: boolean[] = [];
  let syncCount = 0;
  const client = {
    sessionId: "leaving-session",
    userData: { userId: "user-1" },
  } as unknown as Client;
  const player = { userId: "user-1", inputX: 1, inputY: -1 };
  const harness = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  harness.clients = [];
  harness.core = {
    players: new Map([[player.userId, player]]),
    takeOverPlayerWithAi: (userId: string) => {
      takeoverCalls.push(userId);
      return true;
    },
    setConnected: (_userId: string, connected: boolean) => disconnectedStates.push(connected),
  };
  harness.messageWindows = new Map();
  harness.inputMessageWindows = new Map();
  harness.reliableCommandSequences = new Map();
  harness.visibleEnemies = new Map();
  harness.visibleDrops = new Map();
  harness.visiblePlayerTransforms = new Map();
  harness.inputSequences = new Map([[player.userId, 4]]);
  harness.lastInputAt = new Map([[player.userId, Date.now()]]);
  harness.syncState = () => { syncCount += 1; };

  await PartyRoom.prototype.onLeave.call(harness as unknown as PartyRoom, client, true);

  assert.deepEqual(takeoverCalls, [player.userId]);
  assert.deepEqual(disconnectedStates, []);
  assert.equal(player.inputX, 0);
  assert.equal(player.inputY, 0);
  assert.equal(syncCount, 1);
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
