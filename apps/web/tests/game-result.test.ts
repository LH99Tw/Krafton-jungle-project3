import assert from "node:assert/strict";
import test from "node:test";
import { mergeGameResults, normalizeGameResult } from "../src/features/game/gameResult";
import type { GameResult } from "../src/game/domain/types";

const fallback: GameResult = {
  state: "defeat",
  reason: "fallback",
  elapsed: 12,
  day: 2,
  level: 4,
  teamPower: 90,
  stats: { damage: 20, bossDamage: 3, kills: 2, deaths: 1, structuresBuilt: 1, goldSpent: 4, gatesDestroyed: 1 },
};

test("normalizes valid terminal results and rejects malformed result states", () => {
  assert.equal(normalizeGameResult({ state: "pending" }, fallback), null);
  assert.equal(normalizeGameResult({ state: undefined }, fallback), null);
  const victory = normalizeGameResult({ state: "victory", reason: "  보스 처치  ", elapsed: Number.NaN, stats: { damage: -10 } }, fallback);
  assert.deepEqual(victory, { ...fallback, state: "victory", reason: "보스 처치", stats: { ...fallback.stats, damage: 0 } });
  const abandoned = normalizeGameResult({ state: "abandoned", reason: "" }, fallback);
  assert.equal(abandoned?.state, "defeat");
  assert.equal(abandoned?.reason, "원정이 중단되었습니다.");
});

test("merges duplicate terminal signals without regressing final counters", () => {
  const first: GameResult = { ...fallback, state: "victory", reason: "마왕 처치", elapsed: 100, stats: { ...fallback.stats, damage: 500, bossDamage: 200 } };
  const stale: GameResult = { ...fallback, state: "victory", reason: "마왕 처치", elapsed: 98, stats: { ...fallback.stats, damage: 450, bossDamage: 180 } };
  const merged = mergeGameResults(first, stale);
  assert.equal(merged.elapsed, 100);
  assert.equal(merged.stats.damage, 500);
  assert.equal(merged.stats.bossDamage, 200);
});
