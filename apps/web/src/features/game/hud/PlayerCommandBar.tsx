"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { CLASS_DEFINITIONS } from "@/src/game/content/classes";
import type { GameSnapshot, HeroClassId, PlayerCombatStats } from "@/src/game/domain/types";

const HERO_PORTRAITS: Record<HeroClassId, string> = {
  swordsman: "/Asset/Warrior.webp",
  archer: "/Asset/Archer.webp",
  mage: "/Asset/Mage.webp",
};

function barStyle(value: number, max: number): React.CSSProperties {
  return { "--bar-value": `${max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0}%` } as React.CSSProperties;
}

export function PlayerCommandBar({ snapshot, heroClass, upgradeDraftOpen }: {
  snapshot: GameSnapshot;
  heroClass: HeroClassId;
  upgradeDraftOpen: boolean;
}) {
  const [statsOpen, setStatsOpen] = useState(false);
  const definition = CLASS_DEFINITIONS[heroClass];

  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (event.code === "KeyC" && !event.repeat) setStatsOpen((open) => !open);
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, []);

  return (
    <>
      {statsOpen && <PlayerStatsPanel stats={snapshot.combatStats} onClose={() => setStatsOpen(false)} />}
      <section className={`player-command-bar ${upgradeDraftOpen ? "has-upgrade-draft" : ""}`} aria-label="플레이어 상태와 스킬">
        <Image className="player-command-frame" src="/images/ui/hud/frame-command.png" alt="" width={1024} height={222} sizes="(max-width: 900px) calc(100vw - 20px), 1024px" aria-hidden="true" />
        <div className={`player-profile-portrait is-${heroClass}`} title={`${definition.name} 초상`}>
          <Image src={HERO_PORTRAITS[heroClass]} alt={`${definition.name} 캐릭터 얼굴`} fill sizes="140px" priority />
        </div>
        <small className="player-profile-level">LV.{snapshot.level}</small>
        <div className="status-bars">
          <div className="hp-line"><span>HP</span><i style={barStyle(snapshot.hp, snapshot.maxHp)} /><b>{Math.ceil(snapshot.hp)} / {snapshot.maxHp}</b></div>
          <div className="xp-line"><span>EXP</span><i style={barStyle(snapshot.xp, snapshot.xpToNext)} /><b>{snapshot.xp} / {snapshot.xpToNext}</b></div>
        </div>
        <div className="command-skill-row">
          <SkillSlot heroClass={heroClass} keyName="Q" name={definition.skills[0].name} cooldown={snapshot.qCooldown} />
          <SkillSlot heroClass={heroClass} keyName="E" name={definition.skills[1].name} cooldown={snapshot.eCooldown} />
        </div>
        <button type="button" className={`stats-toggle ${statsOpen ? "is-open" : ""}`} aria-label="개인 스탯" aria-expanded={statsOpen} onClick={() => setStatsOpen((open) => !open)}>
          <span className="stats-toggle-icon"><Image src="/images/ui/hud/skills/stats.png" alt="" width={58} height={58} /><i>C</i></span>
        </button>
      </section>
    </>
  );
}

function SkillSlot({ heroClass, keyName, name, cooldown }: { heroClass: HeroClassId; keyName: "Q" | "E"; name: string; cooldown: number }) {
  const ready = cooldown <= 0;
  return (
    <span className={`command-skill ${ready ? "is-ready" : "is-cooling"}`} title={`${keyName} · ${name}`} aria-label={`${keyName} ${name}${ready ? " 사용 가능" : ` 재사용 대기 ${cooldown.toFixed(1)}초`}`}>
      <Image className="command-skill-icon" src={`/images/ui/hud/skills/${heroClass}-${keyName.toLowerCase()}.png`} alt="" width={72} height={72} />
      <i>{keyName}</i>{!ready && <small>{cooldown.toFixed(1)}</small>}
    </span>
  );
}

function PlayerStatsPanel({ stats, onClose }: { stats: PlayerCombatStats; onClose: () => void }) {
  const rows = [
    ["공격력", Math.round(stats.attackDamage).toString()],
    ["치명타 확률", `${stats.criticalChance.toFixed(0)}%`],
    ["치명타 피해", `${stats.criticalDamage.toFixed(0)}%`],
    ["초당 공격", stats.attacksPerSecond.toFixed(2)],
    ["공격 사거리", Math.round(stats.attackRange).toString()],
  ] as const;
  return (
    <aside className="player-stats-panel" aria-label="개인 전투 스탯">
      <header><button type="button" onClick={onClose}>닫기</button></header>
      <h2>개인 전투 스탯</h2>
      <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </aside>
  );
}
