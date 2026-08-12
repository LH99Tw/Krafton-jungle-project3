import type { GameResult, GameSnapshot, TeamStats } from "@/src/game/domain/types";

const STAT_KEYS = ["damage", "bossDamage", "kills", "deaths", "structuresBuilt", "gatesDestroyed"] as const satisfies readonly (keyof TeamStats)[];

export type GameResultSignal = Readonly<{
  state?: unknown;
  reason?: unknown;
  elapsed?: unknown;
  day?: unknown;
  level?: unknown;
  teamPower?: unknown;
  stats?: Partial<Record<keyof TeamStats, unknown>> | null;
}>;

export function resultFallbackFromSnapshot(snapshot: GameSnapshot): GameResult {
  return {
    state: "defeat",
    reason: "원정이 종료되었습니다.",
    elapsed: snapshot.elapsed,
    day: snapshot.day,
    level: snapshot.level,
    teamPower: snapshot.teamPower,
    stats: { ...snapshot.stats },
  };
}

export function normalizeGameResult(signal: GameResultSignal, fallback: GameResult): GameResult | null {
  const rawState = signal.state;
  if (rawState !== "victory" && rawState !== "defeat" && rawState !== "abandoned") return null;
  const state = rawState === "victory" ? "victory" : "defeat";
  const defaultReason = rawState === "victory"
    ? "마왕을 쓰러뜨리고 왕국을 지켜냈습니다."
    : rawState === "abandoned"
      ? "원정이 중단되었습니다."
      : "원정에 실패했습니다.";
  const reason = typeof signal.reason === "string" && signal.reason.trim()
    ? signal.reason.trim().slice(0, 240)
    : defaultReason;
  const stats = { ...fallback.stats };
  for (const key of STAT_KEYS) stats[key] = safeNonNegative(signal.stats?.[key], fallback.stats[key], true);
  return {
    state,
    reason,
    elapsed: safeNonNegative(signal.elapsed, fallback.elapsed),
    day: Math.max(1, safeNonNegative(signal.day, fallback.day, true)),
    level: Math.max(1, safeNonNegative(signal.level, fallback.level, true)),
    teamPower: safeNonNegative(signal.teamPower, fallback.teamPower, true),
    stats,
  };
}

export function mergeGameResults(current: GameResult, incoming: GameResult): GameResult {
  if (current.state !== incoming.state) return incoming;
  const stats = { ...current.stats };
  for (const key of STAT_KEYS) stats[key] = Math.max(current.stats[key], incoming.stats[key]);
  return {
    ...incoming,
    elapsed: Math.max(current.elapsed, incoming.elapsed),
    day: Math.max(current.day, incoming.day),
    level: Math.max(current.level, incoming.level),
    teamPower: Math.max(current.teamPower, incoming.teamPower),
    stats,
  };
}

function safeNonNegative(value: unknown, fallback: number, integer = false): number {
  const safeFallback = Number.isFinite(fallback) ? Math.max(0, fallback) : 0;
  if (typeof value !== "number" || !Number.isFinite(value)) return integer ? Math.round(safeFallback) : safeFallback;
  const safeValue = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value));
  return integer ? Math.round(safeValue) : safeValue;
}
