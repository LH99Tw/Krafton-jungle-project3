import type { CSSProperties } from "react";
import type { PartyMemberSnapshot } from "@/src/game/domain/types";

const PARTY_SIZE = 3;

export function PartyVitalsHud({
  party,
  gateProgress,
}: {
  party: PartyMemberSnapshot[];
  gateProgress: { round: number; destroyed: number; goal: number };
}) {
  const slots = Array.from({ length: PARTY_SIZE }, (_, index) => party[index] ?? null);

  return (
    <section className="party-vitals" aria-label="파티 체력과 게이트 파괴 진행도">
      <div className="party-vitals-list">
        {slots.map((member, index) => {
          if (!member) {
            return (
              <div className="party-vital is-empty" key={`empty-${index}`} aria-label="빈 파티 자리">
                <span className="party-vital-orb" aria-hidden="true" />
                <small>빈 자리</small>
              </div>
            );
          }
          const health = member.maxHp > 0 ? Math.max(0, Math.min(1, member.hp / member.maxHp)) : 0;
          const healthTone = health > 0.6 ? "is-healthy" : health > 0.3 ? "is-wounded" : "is-critical";
          const style = { "--party-health": `${health * 100}%` } as CSSProperties;
          return (
            <div
              className={`party-vital ${healthTone} ${member.isLocal ? "is-local" : ""} ${member.connected ? "" : "is-offline"}`}
              key={member.userId}
              aria-label={`${member.displayName} 체력 ${Math.ceil(member.hp)} / ${member.maxHp}`}
            >
              <span className="party-vital-orb" style={style} aria-hidden="true"><i /></span>
              <small title={member.displayName}>{member.displayName}</small>
            </div>
          );
        })}
      </div>
      <div className={`party-gate-progress ${gateProgress.destroyed >= gateProgress.goal ? "is-complete" : ""}`}>
        <span className="party-gate-emblem" aria-hidden="true" />
        <div>
          <small>ZONE {gateProgress.round} · 게이트 파괴</small>
          <b>{gateProgress.destroyed >= gateProgress.goal ? "구역 개방 완료" : "균열 관문을 파괴하세요"}</b>
        </div>
        <strong>{gateProgress.destroyed}<i>/</i>{gateProgress.goal}</strong>
        <span className="party-gate-meter" style={{ "--gate-progress": `${Math.min(100, gateProgress.destroyed / Math.max(1, gateProgress.goal) * 100)}%` } as CSSProperties} aria-hidden="true" />
      </div>
    </section>
  );
}
