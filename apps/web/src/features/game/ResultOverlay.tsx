"use client";

import { CLASS_DEFINITIONS } from "@/src/game/content/classes";
import type { GameResult, HeroClassId } from "@/src/game/domain/types";

function formatElapsed(seconds: number): string {
  const value = Math.max(0, Math.round(seconds));
  return `${Math.floor(value / 60)}:${(value % 60).toString().padStart(2, "0")}`;
}

export function ResultOverlay({
  result,
  heroClass,
  onRetry,
  onLobby,
}: {
  result: GameResult | null;
  heroClass: HeroClassId;
  onRetry: () => void;
  onLobby: () => void;
}) {
  if (!result) return null;
  const victory = result.state === "victory";
  const className = CLASS_DEFINITIONS[heroClass].name;
  const mvpTitle = result.stats.bossDamage > result.stats.damage * 0.5 ? "마왕의 천적" : result.stats.structuresBuilt >= 3 ? "기지의 설계자" : "원정대 에이스";

  return (
    <div className="modal-backdrop result-backdrop" role="dialog" aria-modal="true" aria-labelledby="result-title">
      <section className={`result-modal ${victory ? "is-victory" : "is-defeat"}`}>
        <span className="result-kicker">EXPEDITION REPORT · DAY {result.day}</span>
        <div className="result-emblem"><span>{victory ? "V" : "X"}</span></div>
        <h2 id="result-title">{victory ? "마왕 토벌 완료" : "원정 실패"}</h2>
        <p>{result.reason}</p>
        <div className="result-mvp"><small>YOUR TITLE</small><strong>{mvpTitle}</strong><span>{className} · 팀 전투력 {result.teamPower}</span></div>
        <dl className="result-stats">
          <div><dt>작전 시간</dt><dd>{formatElapsed(result.elapsed)}</dd></div>
          <div><dt>최종 레벨</dt><dd>LV.{result.level}</dd></div>
          <div><dt>총 피해량</dt><dd>{result.stats.damage.toLocaleString()}</dd></div>
          <div><dt>마왕 피해</dt><dd>{result.stats.bossDamage.toLocaleString()}</dd></div>
          <div><dt>처치 수</dt><dd>{result.stats.kills}</dd></div>
          <div><dt>시설 기여</dt><dd>{result.stats.structuresBuilt}</dd></div>
        </dl>
        <div className="result-actions">
          <button type="button" className="secondary-action" onClick={onLobby}>작전실로</button>
          <button type="button" className="primary-action" onClick={onRetry}>같은 설정으로 재도전</button>
        </div>
      </section>
    </div>
  );
}

