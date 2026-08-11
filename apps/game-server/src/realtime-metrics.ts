type TransportChannel = "webtransport" | "websocket";

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
    },
  };
}

function currentInvaderTotals(): { active: number; pending: number } {
  return [...roomInvaderMetrics.values()].reduce((total, room) => ({
    active: total.active + room.active,
    pending: total.pending + room.pending,
  }), { active: 0, pending: 0 });
}
