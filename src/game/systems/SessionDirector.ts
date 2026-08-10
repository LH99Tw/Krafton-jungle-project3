import { SESSION_DURATIONS } from "../content/balance";
import type { Phase, SessionMode } from "../domain/types";

export type PhaseTransition = {
  previous: Phase;
  current: Phase;
  day: number;
};

export class SessionDirector {
  day = 1;
  phase: Phase = "day";
  phaseRemaining: number;
  elapsed = 0;

  constructor(private readonly mode: SessionMode) {
    this.phaseRemaining = SESSION_DURATIONS[mode].day;
  }

  update(deltaSeconds: number): PhaseTransition | null {
    if (this.phase === "ended") return null;
    this.elapsed += deltaSeconds;
    if (this.phase === "boss") return null;
    this.phaseRemaining -= deltaSeconds;
    if (this.phaseRemaining > 0) return null;

    const previous = this.phase;
    if (this.phase === "day") {
      this.phase = "night";
    } else if (this.phase === "night") {
      this.phase = "standby";
    } else {
      this.day += 1;
      this.phase = this.day > 5 ? "ended" : "day";
    }

    if (this.phase !== "ended") {
      this.phaseRemaining = SESSION_DURATIONS[this.mode][this.phase as "day" | "night" | "standby"];
    } else {
      this.phaseRemaining = 0;
    }

    return { previous, current: this.phase, day: this.day };
  }

  startBoss(): void {
    this.phase = "boss";
    this.phaseRemaining = 0;
  }

  resumeAfterRetreat(): void {
    this.phase = "day";
    this.phaseRemaining = this.mode === "prototype" ? 20 : 60;
  }

  end(): void {
    this.phase = "ended";
    this.phaseRemaining = 0;
  }
}
