import { performance } from "node:perf_hooks";
import { GameCore, OFFICIAL_WORLD, type CoreEnemy, type CorePlayer } from "../src/index";

type Scenario = "far" | "near" | "contact" | "burst";

const roomCount = numberArgument("rooms", 1);
const unitCount = numberArgument("units", 256);
const durationSeconds = numberArgument("seconds", 600);
const targetP99Ms = numberArgument("target-p99", 4);
const targetMaxMs = numberArgument("target-max", 8);
const requestedScenario = stringArgument("scenario", "all");
const scenarios: Scenario[] = requestedScenario === "all"
  ? ["far", "near", "contact", "burst"]
  : [parseScenario(requestedScenario)];

const results = scenarios.map(runScenario);
const passed = results.every((result) => result.p99Ms <= targetP99Ms && result.maxMs <= targetMaxMs);

console.log(JSON.stringify({
  unitsPerRoom: unitCount,
  rooms: roomCount,
  simulatedSeconds: durationSeconds,
  targetP99Ms,
  targetMaxMs,
  results,
  passed,
}, null, 2));

if (!passed) process.exitCode = 1;

function runScenario(scenario: Scenario) {
  const rooms = Array.from({ length: roomCount }, (_, roomIndex) => createRoom(scenario, roomIndex));
  const tickSamples: number[] = [];
  // One warmup tick per room absorbs V8 JIT compilation so the measured
  // distribution reflects steady-state 60Hz simulation cost, not first-call
  // codegen. The production room likewise warms up during the lobby phase.
  for (const room of rooms) room.core.update(1 / 60);
  const beforeHeap = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  for (let tick = 0; tick < durationSeconds * 60; tick += 1) {
    for (const room of rooms) {
      const tickStartedAt = performance.now();
      room.core.update(1 / 60);
      tickSamples.push(performance.now() - tickStartedAt);
      if (scenario !== "burst") refillInvaders(room.core, unitCount);
    }
  }
  const elapsedMs = performance.now() - startedAt;
  const sorted = [...tickSamples].sort((left, right) => left - right);
  return {
    scenario,
    elapsedMs,
    msPerRoomSecond: elapsedMs / roomCount / durationSeconds,
    averageTickMs: tickSamples.reduce((sum, value) => sum + value, 0) / tickSamples.length,
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? 0,
    heapDeltaMb: (process.memoryUsage().heapUsed - beforeHeap) / 1024 / 1024,
    finalLiveInvaders: rooms.reduce((sum, room) => sum + room.core.liveInvaderCount, 0),
    finalPendingInvaders: rooms.reduce((sum, room) => sum + room.core.pendingInvaderCount, 0),
    tiers: rooms.map((room) => room.core.invaderSimulationTiers),
  };
}

function createRoom(scenario: Scenario, roomIndex: number): { core: GameCore; player: CorePlayer } {
  const core = new GameCore({
    mode: "prototype",
    difficulty: "normal",
    seed: `invader-load-${scenario}-${roomIndex}`,
    minimumPlayers: 1,
    maxLiveInvaders: unitCount,
    invaderUpdateRates: { warmHz: 20, coldHz: 10 },
    world: OFFICIAL_WORLD,
  });
  const player = core.addPlayer({ userId: `observer-${roomIndex}`, displayName: "observer", heroClass: "swordsman" });
  core.setReady(player.userId, true);
  core.baseMaxHp = 1_000_000_000;
  core.baseHp = core.baseMaxHp;
  player.hp = 1_000_000_000;
  player.maxHp = player.hp;
  player.autoAttackCooldown = 1_000_000_000;

  if (scenario === "burst") {
    const gate = [...core.enemies.values()].find((enemy) => enemy.kind === "gate" && enemy.alive)!;
    const enqueue = (core as unknown as {
      enqueueInvaderWave(gateEnemyId: string, zone: 1, count: number): void;
    }).enqueueInvaderWave.bind(core);
    enqueue(gate.id, 1, unitCount);
    core.setConnected(player.userId, false);
    return { core, player };
  }

  refillInvaders(core, unitCount);
  if (scenario === "far") {
    core.setConnected(player.userId, false);
    return { core, player };
  }

  const invaders = livingInvaders(core);
  const anchor = invaders[0]!;
  core.movePlayerToRoom(player.userId, anchor.roomId);
  player.x = anchor.x + (scenario === "near" ? 900 : 0);
  player.y = anchor.y;
  if (scenario === "contact") {
    invaders.forEach((invader, index) => {
      const angle = index / invaders.length * Math.PI * 2;
      const radius = 40 + index % 16 * 20;
      invader.roomId = player.roomId;
      invader.x = player.x + Math.cos(angle) * radius;
      invader.y = player.y + Math.sin(angle) * radius;
    });
  }
  return { core, player };
}

function refillInvaders(core: GameCore, count: number): void {
  while (core.liveInvaderCount < count) core.spawnInvader(1);
}

function livingInvaders(core: GameCore): CoreEnemy[] {
  return [...core.enemies.values()].filter((enemy) => enemy.alive && enemy.behavior === "invader");
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function parseScenario(value: string): Scenario {
  if (value === "far" || value === "near" || value === "contact" || value === "burst") return value;
  throw new Error(`Invalid --scenario=${value}`);
}

function stringArgument(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function numberArgument(name: string, fallback: number): number {
  const value = Number(stringArgument(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid --${name} value`);
  return value;
}
