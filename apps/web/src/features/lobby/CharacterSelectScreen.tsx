"use client";

import type { HeroClassId } from "@five-days/protocol";
import Image from "next/image";
import { CLASS_DEFINITIONS } from "@/src/game/content/classes";
import type { LobbySnapshot } from "@/src/game/transport/LobbyTransport";

const DISPLAY_ORDER: HeroClassId[] = ["archer", "swordsman", "mage"];
const CONCEPT_ART_PATHS: Record<HeroClassId, string> = {
  swordsman: "/Asset/Warrior.webp",
  archer: "/Asset/Archer.webp",
  mage: "/Asset/Mage.webp",
};

export function CharacterSelectScreen({ snapshot, viewerId, launching, curtainVisible, onSelect }: { snapshot: LobbySnapshot; viewerId: string; launching: boolean; curtainVisible: boolean; onSelect: (heroClass: HeroClassId | null) => void }) {
  const me = snapshot.players.find((player) => player.userId === viewerId);
  const allSelected = snapshot.players.length > 0 && snapshot.players.every((player) => player.heroClass);
  const readying = snapshot.launchAt > 0;
  return <main className={`character-select-screen ${launching ? "is-launching" : ""}`}>
    <section className="team-picks" aria-label="팀원 선택 현황">
      {snapshot.players.map((player) => <div key={player.userId} className={player.heroClass ? "has-pick" : ""} data-hero-class={player.heroClass ?? "unselected"}>
        <span className="team-pick-image" aria-hidden="true">
          {player.heroClass ? <Image src={CONCEPT_ART_PATHS[player.heroClass]} alt="" fill sizes="33vw" /> : <i>◇</i>}
        </span>
        <span className="team-pick-copy"><small>{player.isAi ? "AI 동료" : snapshot.hostId === player.userId ? "원정대장" : "원정대원"}</small><strong>{player.displayName}</strong></span>
        <em>{player.heroClass ? CLASS_DEFINITIONS[player.heroClass].name : "선택 중"}</em>
      </div>)}
    </section>
    <section className="class-slashes" aria-label="캐릭터 클래스 선택">
      {DISPLAY_ORDER.map((classId) => {
        const definition = CLASS_DEFINITIONS[classId];
        const selected = me?.heroClass === classId;
        return <button type="button" key={classId} className={`slash slash--${classId} ${selected ? "is-selected" : ""}`} aria-pressed={selected} disabled={launching || readying} onClick={() => onSelect(selected ? null : classId)} style={{ "--class-accent": definition.cssColor } as React.CSSProperties}>
          <span className="slash-art" aria-hidden="true" />
          <span className="slash-copy"><small>{definition.role}</small><strong>{definition.name}</strong><em>{definition.epithet}</em><p>{definition.description}</p><b>{selected ? "선택됨 · 다시 눌러 취소" : "이 직업 선택"}</b></span>
        </button>;
      })}
    </section>
    <footer className={`select-footer ${allSelected ? "has-all-picks" : ""}`} />
    {curtainVisible ? <div className="launch-curtain" aria-live="assertive"><span>마왕 출현까지 5일</span><strong>원정 개시</strong></div> : null}
  </main>;
}
