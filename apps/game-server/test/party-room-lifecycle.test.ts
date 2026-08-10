import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@colyseus/core";
import {
  OperationTimeoutError,
  PartyRoom,
  runWithTimeoutAndRetry,
} from "../src/party-room";

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
  harness.commandSequences = new Map();
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
