import { performance } from "node:perf_hooks";
import { GameCore, OFFICIAL_WORLD } from "../src/index";

const roomCount = numberArgument("rooms", 5);
const unitCount = numberArgument("units", 256);
const durationSeconds = numberArgument("seconds", 600);
const targetMsPerRoomSecond = numberArgument("target", 7.5);

const rooms = Array.from({ length: roomCount }, (_, roomIndex) => {
  const core = new GameCore({
    mode: "prototype",
    difficulty: "normal",
    seed: `invader-load-${roomIndex}`,
    minimumPlayers: 1,
    maxLiveInvaders: unitCount,
    invaderUpdateRates: { warmHz: 20, coldHz: 10 },
    world: OFFICIAL_WORLD,
  });
  const player = core.addPlayer({ userId: `observer-${roomIndex}`, displayName: "observer", heroClass: "swordsman" });
  core.setReady(player.userId, true);
  core.setConnected(player.userId, false);
  core.baseMaxHp = 1_000_000_000;
  core.baseHp = core.baseMaxHp;
  while (core.liveInvaderCount < unitCount) core.spawnInvader(1);
  return core;
});

const beforeHeap = process.memoryUsage().heapUsed;
const startedAt = performance.now();
for (let tick = 0; tick < durationSeconds * 60; tick += 1) {
  for (const core of rooms) {
    core.update(1 / 60);
    while (core.liveInvaderCount < unitCount) core.spawnInvader(1);
  }
}
const elapsedMs = performance.now() - startedAt;
const heapDeltaMb = (process.memoryUsage().heapUsed - beforeHeap) / 1024 / 1024;
const msPerRoomSecond = elapsedMs / roomCount / durationSeconds;
const passed = msPerRoomSecond <= targetMsPerRoomSecond;

console.log(JSON.stringify({
  rooms: roomCount,
  unitsPerRoom: unitCount,
  simulatedSeconds: durationSeconds,
  elapsedMs,
  msPerRoomSecond,
  targetMsPerRoomSecond,
  heapDeltaMb,
  passed,
}, null, 2));

if (!passed) process.exitCode = 1;

function numberArgument(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid --${name} value`);
  return value;
}
