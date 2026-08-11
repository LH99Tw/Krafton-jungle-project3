import Image from "next/image";
import type { Phase } from "@/src/game/domain/types";

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(safe / 60).toString().padStart(2, "0")}:${(safe % 60).toString().padStart(2, "0")}`;
}

export function PhaseHud({ phase, phaseLabel, day, remaining }: {
  phase: Phase;
  phaseLabel: string;
  day: number;
  remaining: number;
}) {
  const night = phase === "night" || phase === "boss";
  return (
    <section className={`phase-reliquary ${night ? "is-night" : "is-day"}`} aria-label={`${day}일차 ${phaseLabel}`}>
      <div className="phase-day-track" aria-label={`5일 중 ${day}일차`}>
        {[1, 2, 3, 4, 5].map((value) => <span key={value} className={value <= day ? "is-active" : ""}>{value}</span>)}
      </div>
      <div className="phase-emblem" aria-hidden="true">
        <Image
          className="phase-emblem-image"
          src={night ? "/images/ui/hud/phase-night.png" : "/images/ui/hud/phase-day.png"}
          alt=""
          width={96}
          height={96}
          priority
        />
      </div>
      <time>{phase === "boss" ? "FINAL" : formatTime(remaining)}</time>
    </section>
  );
}
