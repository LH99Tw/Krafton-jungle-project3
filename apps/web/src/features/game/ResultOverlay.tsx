"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";
import type { GameResult } from "@/src/game/domain/types";

const RESULT_ASSET_ROOT = "/images/ui/result-screen";

function formatElapsed(seconds: number): string {
  const value = Math.max(0, Math.round(seconds));
  return `${Math.floor(value / 60)}:${(value % 60).toString().padStart(2, "0")}`;
}

export function ResultOverlay({
  result,
  onLobby,
  returnLabel = "게임 로비로 나가기",
}: {
  result: GameResult | null;
  onLobby: () => void;
  returnLabel?: string;
}) {
  const actionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (result) actionRef.current?.focus();
  }, [result]);

  if (!result) return null;
  const victory = result.state === "victory";
  const stats = [
    { label: "작전 시간", value: formatElapsed(result.elapsed), icon: "stat-time.png" },
    { label: "처치 수", value: result.stats.kills.toLocaleString(), icon: "stat-kills.png" },
    { label: "총 피해량", value: result.stats.damage.toLocaleString(), icon: "stat-damage-dealt.png" },
    { label: "시설 기여", value: result.stats.structuresBuilt.toLocaleString(), icon: "stat-damage-taken.png" },
  ] as const;

  return (
    <div className="modal-backdrop result-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="result-title" aria-describedby="result-reason">
      <section className={`result-modal ${victory ? "is-victory" : "is-defeat"}`}>
        <Image className="result-panel-art" src={`${RESULT_ASSET_ROOT}/result-panel.png`} width={1024} height={1536} alt="" aria-hidden="true" priority />
        <div className="result-content">
        <span className="result-kicker">원정 보고 · {result.day}일차</span>
        <Image
          className="result-emblem"
          src={`${RESULT_ASSET_ROOT}/${victory ? "victory-emblem.png" : "defeat-emblem.png"}`}
          width={1254}
          height={1254}
          alt=""
          aria-hidden="true"
        />
        <h2 id="result-title">{victory ? "토벌 성공" : "토벌 실패"}</h2>
        <p id="result-reason">{result.reason}</p>
        <div className="result-section-heading">
          <Image src={`${RESULT_ASSET_ROOT}/section-divider.png`} width={1774} height={887} alt="" aria-hidden="true" />
          <span>파티 성과 요약</span>
        </div>
        <dl className="result-stats">
          {stats.map((stat) => (
            <div key={stat.label}>
              <Image src={`${RESULT_ASSET_ROOT}/${stat.icon}`} width={1254} height={1254} alt="" aria-hidden="true" />
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
        <div className="result-actions">
          <button ref={actionRef} type="button" className="result-exit-action" onClick={onLobby}>
            <Image src={`${RESULT_ASSET_ROOT}/${victory ? "button-victory.png" : "button-defeat.png"}`} width={1774} height={887} alt="" aria-hidden="true" />
            <span>{returnLabel}</span>
          </button>
        </div>
        </div>
      </section>
    </div>
  );
}
