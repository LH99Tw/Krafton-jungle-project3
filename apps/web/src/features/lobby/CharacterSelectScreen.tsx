"use client";

import type { HeroClassId } from "@five-days/protocol";
import { CLASS_DEFINITIONS } from "@/src/game/content/classes";
import type { LobbySnapshot } from "@/src/game/transport/LobbyTransport";

const DISPLAY_ORDER: HeroClassId[] = ["archer", "swordsman", "mage"];

export function CharacterSelectScreen({ snapshot, viewerId, launching, onSelect }: { snapshot: LobbySnapshot; viewerId: string; launching: boolean; onSelect: (heroClass: HeroClassId | null) => void }) {
  const me = snapshot.players.find((player) => player.userId === viewerId);
  return <main className={`character-select-screen ${launching ? "is-launching" : ""}`}>
    <section className="team-picks" aria-label="팀원 선택 현황">
      {snapshot.players.map((player) => <div key={player.userId} className={player.heroClass ? "has-pick" : ""} data-hero-class={player.heroClass ?? "unselected"}>
        <span className="team-pick-image" aria-hidden="true"><i>{player.heroClass ? CLASS_DEFINITIONS[player.heroClass].name.slice(0, 1) : "◇"}</i></span>
        <span className="team-pick-copy"><small>{player.isAi ? "AI 동료" : snapshot.hostId === player.userId ? "원정대장" : "원정대원"}</small><strong>{player.displayName}</strong></span>
        <em>{player.heroClass ? CLASS_DEFINITIONS[player.heroClass].name : "선택 중"}</em>
      </div>)}
    </section>
    <section className="class-slashes" aria-label="캐릭터 클래스 선택">
      {DISPLAY_ORDER.map((classId, index) => {
        const definition = CLASS_DEFINITIONS[classId];
        const selected = me?.heroClass === classId;
        return <button type="button" key={classId} className={`slash slash--${classId} ${selected ? "is-selected" : ""}`} aria-pressed={selected} onClick={() => onSelect(selected ? null : classId)} style={{ "--slash-index": index, "--class-accent": definition.cssColor } as React.CSSProperties}>
          <span className="slash-art" aria-hidden="true"><i>{definition.name.slice(0, 1)}</i></span>
          <span className="slash-copy"><small>{definition.role}</small><strong>{definition.name}</strong><em>{definition.epithet}</em><p>{definition.description}</p><b>{selected ? "선택됨 · 다시 눌러 취소" : "이 직업 선택"}</b></span>
        </button>;
      })}
    </section>
    <footer className="select-footer"><span>{snapshot.players.filter((player) => player.heroClass).length} / 3명 선택</span><div><i /><strong>{launching ? "원정 경로를 여는 중" : me?.heroClass ? "동료의 선택을 기다리는 중" : "출전 직업을 선택하세요"}</strong></div></footer>
    {launching ? <div className="launch-curtain" aria-live="assertive"><span>마왕 출현까지 5일</span><strong>원정 개시</strong></div> : null}
  </main>;
}
