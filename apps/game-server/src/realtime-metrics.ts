import { monitorEventLoopDelay } from "node:perf_hooks";

type TransportChannel = "webtransport" | "websocket";
type TimingStage = "coreUpdate" | "schemaSync" | "aoiUpdate" | "worldFrame";

const TIMING_SAMPLE_LIMIT = 2_048;
const timingSamples: Record<TimingStage, number[]> = {
  coreUpdate: [],
  schemaSync: [],
  aoiUpdate: [],
  worldFrame: [],
};
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

const counters = {
  inputFrames: { webtransport: 0, websocket: 0 },
  worldFrames: { webtransport: 0, websocket: 0 },
  inputLeaseExpirations: 0,
  catchUpTicks: 0,
  droppedCatchUps: 0,
  snapshotBytesTotal: 0,
  snapshotBytesMax: 0,
  invaderCapHits: 0,
  retiredInvaders: 0,
  maxActiveInvaders: 0,
  maxPendingInvaders: 0,
};

type RoomInvaderMetrics = Readonly<{
  active: number;
  pending: number;
  capHits: number;
  retired: number;
  hot?: number;
  warm?: number;
  cold?: number;
  multirateEnabled?: boolean;
}>;

const roomInvaderMetrics = new Map<string, RoomInvaderMetrics>();

export function recordRealtimeInput(channel: TransportChannel): void {
  counters.inputFrames[channel] += 1;
}

export function recordRealtimeWorldFrame(channel: TransportChannel, bytes: number): void {
  counters.worldFrames[channel] += 1;
  counters.snapshotBytesTotal += bytes;
  counters.snapshotBytesMax = Math.max(counters.snapshotBytesMax, bytes);
}

export function recordInputLeaseExpiration(): void {
  counters.inputLeaseExpirations += 1;
}

export function recordSimulationCatchUp(extraTicks: number, dropped: boolean): void {
  counters.catchUpTicks += Math.max(0, extraTicks);
  if (dropped) counters.droppedCatchUps += 1;
}

export function recordRealtimeTiming(stage: TimingStage, elapsedMs: number): void {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
  const samples = timingSamples[stage];
  samples.push(elapsedMs);
  if (samples.length > TIMING_SAMPLE_LIMIT) samples.splice(0, samples.length - TIMING_SAMPLE_LIMIT);
}

export function recordRoomInvaderMetrics(roomId: string, metrics: RoomInvaderMetrics): void {
  const previous = roomInvaderMetrics.get(roomId);
  counters.invaderCapHits += Math.max(0, metrics.capHits - (previous?.capHits ?? 0));
  counters.retiredInvaders += Math.max(0, metrics.retired - (previous?.retired ?? 0));
  roomInvaderMetrics.set(roomId, { ...metrics });
  const current = currentInvaderTotals();
  counters.maxActiveInvaders = Math.max(counters.maxActiveInvaders, current.active);
  counters.maxPendingInvaders = Math.max(counters.maxPendingInvaders, current.pending);
}

export function removeRoomInvaderMetrics(roomId: string): void {
  roomInvaderMetrics.delete(roomId);
}

export function realtimeMetricsSnapshot(): object {
  const worldFrameCount = counters.worldFrames.webtransport + counters.worldFrames.websocket;
  const currentInvaders = currentInvaderTotals();
  const {
    invaderCapHits,
    retiredInvaders,
    maxActiveInvaders,
    maxPendingInvaders,
    ...realtimeCounters
  } = counters;
  return {
    ...realtimeCounters,
    inputFrames: { ...counters.inputFrames },
    worldFrames: { ...counters.worldFrames },
    snapshotBytesAverage: worldFrameCount > 0
      ? Math.round(counters.snapshotBytesTotal / worldFrameCount)
      : 0,
    invaders: {
      active: currentInvaders.active,
      pending: currentInvaders.pending,
      maxActive: maxActiveInvaders,
      maxPending: maxPendingInvaders,
      capHits: invaderCapHits,
      retired: retiredInvaders,
      tiers: currentInvaders.tiers,
      multirateRooms: currentInvaders.multirateRooms,
    },
    timings: Object.fromEntries(Object.entries(timingSamples).map(([stage, samples]) => [stage, timingSummary(samples)])),
    eventLoopDelay: {
      meanMs: Number.isFinite(eventLoopDelay.mean) ? eventLoopDelay.mean / 1_000_000 : 0,
      p95Ms: eventLoopDelay.percentile(95) / 1_000_000,
      p99Ms: eventLoopDelay.percentile(99) / 1_000_000,
      maxMs: eventLoopDelay.max / 1_000_000,
    },
  };
}

function currentInvaderTotals(): {
  active: number;
  pending: number;
  tiers: { hot: number; warm: number; cold: number };
  multirateRooms: number;
} {
  return [...roomInvaderMetrics.values()].reduce((total, room) => ({
    active: total.active + room.active,
    pending: total.pending + room.pending,
    tiers: {
      hot: total.tiers.hot + (room.hot ?? 0),
      warm: total.tiers.warm + (room.warm ?? 0),
      cold: total.tiers.cold + (room.cold ?? 0),
    },
    multirateRooms: total.multirateRooms + (room.multirateEnabled ? 1 : 0),
  }), { active: 0, pending: 0, tiers: { hot: 0, warm: 0, cold: 0 }, multirateRooms: 0 });
}

function timingSummary(samples: readonly number[]): object {
  if (samples.length === 0) return { count: 0, averageMs: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    count: samples.length,
    averageMs: samples.reduce((total, value) => total + value, 0) / samples.length,
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: sorted[sorted.length - 1],
  };
}
