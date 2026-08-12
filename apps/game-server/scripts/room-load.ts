import { performance } from "node:perf_hooks";
import { GameCore, OFFICIAL_WORLD } from "@five-days/game-core";
import { PartyRoom } from "../src/party-room";
import { PartyRoomState } from "../src/state";

type RoomHarness = {
  core: GameCore;
  room: PartyRoom;
  syncState(forceKeyframe?: boolean): void;
  updateClientViews(): void;
  emitWorldFrames(): void;
};

const roomCount = numberArgument("rooms", 8);
const unitCount = numberArgument("units", 256);
const clientCount = numberArgument("clients", 3);
const durationSeconds = numberArgument("seconds", 60);
const warmupSeconds = numberArgument("warmup", 5);
const scenario = stringArgument("scenario", "cold");
if (scenario !== "cold" && scenario !== "contact") throw new Error(`Invalid --scenario=${scenario}`);
let serializedBytes = 0;

globalThis.gc?.();
const heapBeforeRooms = process.memoryUsage().heapUsed;
const rooms = Array.from({ length: roomCount }, (_, index) => createRoom(index));
globalThis.gc?.();
const heapAfterRooms = process.memoryUsage().heapUsed;

runTicks(warmupSeconds * 60, false);
globalThis.gc?.();
serializedBytes = 0;
const heapBeforeRun = process.memoryUsage().heapUsed;
const cpuBefore = process.cpuUsage();
const startedAt = performance.now();
const samples = runTicks(durationSeconds * 60, true);
const wallMs = performance.now() - startedAt;
const cpu = process.cpuUsage(cpuBefore);
globalThis.gc?.();
const heapAfterRun = process.memoryUsage().heapUsed;
const sorted = samples.sort((left, right) => left - right);
const cpuMs = (cpu.user + cpu.system) / 1_000;
const outboundMbps = serializedBytes * 8 / durationSeconds / 1_000_000;

console.log(JSON.stringify({
  rooms: roomCount,
  unitsPerRoom: unitCount,
  clientsPerRoom: clientCount,
  scenario,
  simulatedSeconds: durationSeconds,
  wallMs,
  cpuMs,
  cpuCoreEquivalent: cpuMs / (durationSeconds * 1_000),
  sustainableRoomsPerFullCoreAt60Percent: roomCount * 0.6 / (cpuMs / (durationSeconds * 1_000)),
  averageRoomTickMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
  p95RoomTickMs: percentile(sorted, 0.95),
  p99RoomTickMs: percentile(sorted, 0.99),
  maxRoomTickMs: sorted.at(-1) ?? 0,
  heapMbPerRoom: (heapAfterRooms - heapBeforeRooms) / roomCount / 1024 / 1024,
  retainedHeapDeltaMb: (heapAfterRun - heapBeforeRun) / 1024 / 1024,
  serializedWorldFrameMbps: outboundMbps,
  projectedThirtyDayTransferTb: serializedBytes / durationSeconds * 30 * 24 * 60 * 60 / 1_000_000_000_000,
}, null, 2));

function runTicks(ticks: number, record: boolean): number[] {
  const samples: number[] = [];
  for (let tick = 1; tick <= ticks; tick += 1) {
    for (const harness of rooms) {
      const started = performance.now();
      harness.core.update(1 / 60);
      refillInvaders(harness.core);
      if (tick % 2 === 0) harness.emitWorldFrames();
      if (tick % 6 === 0) {
        harness.syncState();
        harness.updateClientViews();
      }
      if (record) samples.push(performance.now() - started);
    }
  }
  return samples;
}

function createRoom(roomIndex: number): RoomHarness {
  const core = new GameCore({
    mode: "prototype",
    difficulty: "normal",
    seed: `room-load-${roomIndex}`,
    minimumPlayers: clientCount,
    maxLiveInvaders: unitCount,
    invaderUpdateRates: { warmHz: 20, coldHz: 5, warmMovementHz: 30, coldMovementHz: 10 },
    world: OFFICIAL_WORLD,
  });
  core.baseMaxHp = 1_000_000_000;
  core.baseHp = core.baseMaxHp;
  for (let playerIndex = 0; playerIndex < clientCount; playerIndex += 1) {
    const player = core.addPlayer({
      userId: `load-${roomIndex}-${playerIndex}`,
      displayName: `load-${playerIndex}`,
      heroClass: playerIndex % 3 === 0 ? "swordsman" : playerIndex % 3 === 1 ? "archer" : "mage",
    });
    player.ready = true;
    player.hp = 1_000_000_000;
    player.maxHp = player.hp;
    player.autoAttackCooldown = 1_000_000_000;
  }
  for (const roomId of core.rooms.keys()) core.discoveredRooms.add(roomId);
  refillInvaders(core);
  if (scenario === "contact") {
    const invaders = [...core.enemies.values()].filter((enemy) => enemy.alive && enemy.behavior === "invader");
    const anchor = invaders[0]!;
    const players = [...core.players.values()];
    for (const player of players) {
      core.movePlayerToRoom(player.userId, anchor.roomId);
      player.x = anchor.x;
      player.y = anchor.y;
    }
    invaders.forEach((invader, index) => {
      const angle = index / invaders.length * Math.PI * 2;
      const radius = 40 + index % 16 * 20;
      invader.roomId = anchor.roomId;
      invader.x = anchor.x + Math.cos(angle) * radius;
      invader.y = anchor.y + Math.sin(angle) * radius;
    });
  }

  const raw = Object.create(PartyRoom.prototype) as Record<string, unknown>;
  raw.core = core;
  raw.state = new PartyRoomState();
  raw.schemaRoomIds = new Map();
  raw.previousTransforms = new Map();
  raw.lastEnemyFramePositions = new Map();
  raw.enemyIdsByRoom = new Map();
  raw.enemyRoomMembership = new Map();
  raw.enemySchemaSnapshots = new Map();
  raw.clientEnemyViewRevision = new Map();
  raw.enemyMembershipRevision = 0;
  raw.visibleEnemies = new Map();
  raw.visibleDrops = new Map();
  raw.visiblePlayerTransforms = new Map();
  raw.inputSequences = new Map();
  raw.aoiRoomCache = new Map();
  raw.lastKeyframeAt = 0;
  raw.serverTick = 0;
  raw.websocketSizeSamples = 0;
  raw.lastWebsocketFrameBytes = 0;
  raw.clients = [...core.players.values()].map((player, playerIndex) => ({
    sessionId: `session-${roomIndex}-${playerIndex}`,
    userData: { userId: player.userId },
    view: { add: () => undefined, remove: () => undefined },
    send: (_type: string, payload: unknown) => {
      serializedBytes += Buffer.byteLength(JSON.stringify(payload));
    },
  }));

  const room = raw as unknown as PartyRoom;
  const methods = PartyRoom.prototype as unknown as {
    syncState(this: PartyRoom, forceKeyframe?: boolean): void;
    updateClientViews(this: PartyRoom): void;
    emitWorldFrames(this: PartyRoom): void;
  };
  const harness: RoomHarness = {
    core,
    room,
    syncState: (forceKeyframe) => methods.syncState.call(room, forceKeyframe),
    updateClientViews: () => methods.updateClientViews.call(room),
    emitWorldFrames: () => {
      raw.serverTick = (raw.serverTick as number) + 2;
      methods.emitWorldFrames.call(room);
    },
  };
  harness.syncState(true);
  harness.updateClientViews();
  return harness;
}

function refillInvaders(core: GameCore): void {
  while (core.liveInvaderCount < unitCount) core.spawnInvader(1);
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function numberArgument(name: string, fallback: number): number {
  const value = Number(stringArgument(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid --${name} value`);
  return Math.floor(value);
}

function stringArgument(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}
