"use client";

import type { HeroClassId } from "@five-days/protocol";
import { CLASS_DEFINITIONS } from "@/src/game/content/classes";
import type { LobbySnapshot } from "@/src/game/transport/LobbyTransport";

const DISPLAY_ORDER: HeroClassId[] = ["archer", "swordsman", "mage"];

export function CharacterSelectScreen({ snapshot, viewerId, launching, onSelect }: { snapshot: LobbySnapshot; viewerId: string; launching: boolean; onSelect: (heroClass: HeroClassId | null) => void }) {
  const me = snapshot.players.find((player) => player.userId === viewerId);
  return <main className={`character-select-screen ${launching ? "is-launching" : ""}`}>
    <header className="select-header"><div><span>V</span><strong>출전 클래스 선택</strong></div><p>같은 클래스를 함께 선택할 수 있습니다. 다시 누르면 선택이 취소됩니다.</p><b>{snapshot.roomName}</b></header>
    <section className="team-picks" aria-label="팀원 선택 현황">
      {snapshot.players.map((player, index) => <div key={player.userId} className={player.heroClass ? "has-pick" : ""}><i>0{index + 1}</i><span><small>{player.isAi ? "AI COMPANION" : snapshot.hostId === player.userId ? "LEADER" : "OPERATIVE"}</small><strong>{player.displayName}</strong></span><em>{player.heroClass ? CLASS_DEFINITIONS[player.heroClass].name : "선택 중"}</em></div>)}
    </section>
    <section className="class-slashes" aria-label="캐릭터 클래스 선택">
      {DISPLAY_ORDER.map((classId, index) => {
        const definition = CLASS_DEFINITIONS[classId];
        const selected = me?.heroClass === classId;
        return <button type="button" key={classId} className={`slash slash--${classId} ${selected ? "is-selected" : ""}`} aria-pressed={selected} onClick={() => onSelect(selected ? null : classId)} style={{ "--slash-index": index, "--class-accent": definition.cssColor } as React.CSSProperties}>
          <span className="slash-art" aria-hidden="true"><i>{definition.name.slice(0, 1)}</i></span>
          <span className="slash-copy"><small>0{index + 1} / {definition.role}</small><strong>{definition.name}</strong><em>{definition.epithet}</em><p>{definition.description}</p><b>{selected ? "선택 완료 · 다시 눌러 취소" : "이 클래스 선택"}</b></span>
        </button>;
      })}
    </section>
    <footer className="select-footer"><span>{snapshot.players.filter((player) => player.heroClass).length} / 3 SELECTED</span><div><i /><strong>{launching ? "원정 경로를 여는 중" : me?.heroClass ? "팀원 선택 대기 중" : "출전 클래스를 선택하세요"}</strong></div></footer>
    {launching ? <div className="launch-curtain" aria-live="assertive"><span>DAY − 5</span><strong>원정 개시</strong></div> : null}
  </main>;
}
