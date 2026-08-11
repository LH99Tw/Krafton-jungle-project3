type TransportChannel = "webtransport" | "websocket";

const counters = {
  inputFrames: { webtransport: 0, websocket: 0 },
  worldFrames: { webtransport: 0, websocket: 0 },
  inputLeaseExpirations: 0,
  catchUpTicks: 0,
  droppedCatchUps: 0,
  snapshotBytesTotal: 0,
  snapshotBytesMax: 0,
};

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

export function realtimeMetricsSnapshot(): object {
  const worldFrameCount = counters.worldFrames.webtransport + counters.worldFrames.websocket;
  return {
    ...counters,
    inputFrames: { ...counters.inputFrames },
    worldFrames: { ...counters.worldFrames },
    snapshotBytesAverage: worldFrameCount > 0
      ? Math.round(counters.snapshotBytesTotal / worldFrameCount)
      : 0,
  };
}
