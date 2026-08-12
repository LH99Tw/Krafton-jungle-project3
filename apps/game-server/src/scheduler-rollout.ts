const ROLLOUT_STAGES = [10, 50, 100] as const;
const MIN_ROOM_MILLISECONDS = 5 * 60 * 1_000;
const MIN_SIMULATION_TICKS = 100_000;
const OBSERVATION_WINDOW_MS = 10_000;

export type SchedulerObservation = Readonly<{
  elapsedMs: number;
  simulationTicks: number;
  coreUpdateMs: number;
  droppedCatchUp: boolean;
  oldestPathWaitSeconds: number;
  generatedActions: number;
  transmittedActions: number;
}>;

/** Process-local canary controller. A runtime flag can force the legacy 60 Hz path at any time. */
export class SchedulerRolloutController {
  private stageIndex = 0;
  private collectedRoomMs = 0;
  private collectedTicks = 0;
  private windowMs = 0;
  private windowBad = false;
  private readonly coreUpdateSamples: number[] = [];
  private consecutiveBadWindows = 0;

  constructor(private readonly disabled = false, initialPercent = 10) {
    const requestedIndex = ROLLOUT_STAGES.findIndex((stage) => initialPercent <= stage);
    this.stageIndex = requestedIndex < 0 ? ROLLOUT_STAGES.length - 1 : requestedIndex;
  }

  get percent(): number {
    return this.disabled ? 0 : ROLLOUT_STAGES[this.stageIndex];
  }

  enabledFor(roomId: string): boolean {
    return !this.disabled && rolloutBucket(roomId) < this.percent;
  }

  observe(observation: SchedulerObservation): void {
    if (this.disabled) return;
    this.collectedRoomMs += Math.max(0, observation.elapsedMs);
    this.collectedTicks += Math.max(0, observation.simulationTicks);
    this.windowMs += Math.max(0, observation.elapsedMs);
    if (observation.simulationTicks > 0) this.coreUpdateSamples.push(observation.coreUpdateMs);
    this.windowBad ||= observation.droppedCatchUp
      || observation.oldestPathWaitSeconds > 1
      || observation.generatedActions !== observation.transmittedActions;
    if (this.windowMs < OBSERVATION_WINDOW_MS) return;
    const sorted = this.coreUpdateSamples.sort((left, right) => left - right);
    const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
    const badWindow = this.windowBad || percentile(0.95) > 8 || percentile(0.99) > 12;
    this.consecutiveBadWindows = badWindow ? this.consecutiveBadWindows + 1 : 0;
    this.windowMs = 0;
    this.windowBad = false;
    this.coreUpdateSamples.length = 0;
    if (this.consecutiveBadWindows >= 2) {
      this.stageIndex = Math.max(0, this.stageIndex - 1);
      this.resetStageEvidence();
      return;
    }
    if (this.collectedRoomMs >= MIN_ROOM_MILLISECONDS
      && this.collectedTicks >= MIN_SIMULATION_TICKS
      && this.stageIndex < ROLLOUT_STAGES.length - 1) {
      this.stageIndex += 1;
      this.resetStageEvidence();
    }
  }

  snapshot(): Readonly<{ percent: number; roomMinutes: number; simulationTicks: number; badWindows: number }> {
    return {
      percent: this.percent,
      roomMinutes: this.collectedRoomMs / 60_000,
      simulationTicks: this.collectedTicks,
      badWindows: this.consecutiveBadWindows,
    };
  }

  private resetStageEvidence(): void {
    this.collectedRoomMs = 0;
    this.collectedTicks = 0;
    this.consecutiveBadWindows = 0;
  }
}

function rolloutBucket(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 100;
}

const configuredInitialPercent = Number(process.env.INVADER_MULTIRATE_PERCENT ?? 10);
export const schedulerRollout = new SchedulerRolloutController(
  process.env.INVADER_SCHEDULER_DISABLED === "true",
  Number.isFinite(configuredInitialPercent) ? configuredInitialPercent : 10,
);
