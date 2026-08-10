"use client";

import { CLASS_DEFINITIONS } from "@/src/game/content/classes";
import { BUILDINGS } from "@/src/game/content/balance";
import type { GameSnapshot, HeroClassId } from "@/src/game/domain/types";
import { gameBridge } from "@/src/game/runtime/GameBridge";

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(safe / 60).toString().padStart(2, "0")}:${(safe % 60).toString().padStart(2, "0")}`;
}

function barStyle(value: number, max: number): React.CSSProperties {
  return { "--bar-value": `${max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0}%` } as React.CSSProperties;
}

export function GameHud({
  snapshot,
  heroClass,
  onExit,
}: {
  snapshot: GameSnapshot;
  heroClass: HeroClassId;
  onExit: () => void;
}) {
  const definition = CLASS_DEFINITIONS[heroClass];
  const phaseWarning = snapshot.phase === "night" || snapshot.phase === "boss";

  return (
    <div className="hud-root">
      <div className={`phase-banner ${phaseWarning ? "is-danger" : ""}`}>
        <div className="day-pips" aria-label={`${snapshot.day}일차`}>
          {[1, 2, 3, 4, 5].map((day) => <span key={day} className={day <= snapshot.day ? "active" : ""}>{day}</span>)}
        </div>
        <div className="phase-copy"><small>DAY {snapshot.day} / 05</small><strong>{snapshot.phaseLabel}</strong></div>
        <time>{snapshot.phase === "boss" ? "FINAL" : formatTime(snapshot.phaseRemaining)}</time>
      </div>

      <section className="party-panel hud-panel" aria-label="파티 상태">
        <div className="hud-panel-title"><span>EXPEDITION PARTY</span><button type="button" onClick={onExit}>나가기</button></div>
        {[heroClass, ...(["swordsman", "archer", "mage"] as HeroClassId[]).filter((id) => id !== heroClass)].map((id, index) => {
          const member = CLASS_DEFINITIONS[id];
          const hp = index === 0 ? snapshot.hp : snapshot.maxHp * 0.78;
          return (
            <div className={`party-member ${index === 0 ? "is-you" : ""}`} key={id}>
              <span className={`party-avatar party-avatar--${id}`}>{member.name.slice(0, 1)}</span>
              <div><strong>{index === 0 ? `${member.name} · YOU` : `${member.name} · BOT`}</strong><span className="micro-bar" style={barStyle(hp, snapshot.maxHp)} /></div>
              <small>{Math.ceil(hp)}</small>
            </div>
          );
        })}
        <div className="objective-list">
          <span><i className={snapshot.gatesDestroyed >= 3 ? "done" : ""} /> 게이트 파괴 <b>{snapshot.gatesDestroyed}/3</b></span>
          <span><i className={snapshot.day >= 3 ? "done" : ""} /> 3일차 도달 <b>{snapshot.day}/3</b></span>
        </div>
      </section>

      <section className="resource-panel hud-panel" aria-label="기지 건설">
        <div className="resource-row"><span>TEAM GOLD</span><strong>{snapshot.gold}<small>G</small></strong></div>
        <div className="base-health">
          <span><b>베이스 내구도</b><small>{Math.ceil(snapshot.baseHp)} / {snapshot.baseMaxHp}</small></span>
          <span className="base-bar" style={barStyle(snapshot.baseHp, snapshot.baseMaxHp)} />
        </div>
        <div className="build-tools">
          <button type="button" className={snapshot.buildMode === "turret" ? "active" : ""} onClick={() => gameBridge.command({ type: "set-build-mode", buildMode: snapshot.buildMode === "turret" ? null : "turret" })}>
            <span className="build-icon build-icon--turret" /><b>포탑</b><small>{BUILDINGS.turret.cost}G</small>
          </button>
          <button type="button" className={snapshot.buildMode === "wall" ? "active" : ""} onClick={() => gameBridge.command({ type: "set-build-mode", buildMode: snapshot.buildMode === "wall" ? null : "wall" })}>
            <span className="build-icon build-icon--wall" /><b>장벽</b><small>{BUILDINGS.wall.cost}G</small>
          </button>
          <button type="button" className={snapshot.buildMode === "upgrade" ? "active" : ""} onClick={() => gameBridge.command({ type: "set-build-mode", buildMode: snapshot.buildMode === "upgrade" ? null : "upgrade" })}>
            <span className="build-icon build-icon--upgrade">↑</span><b>강화</b><small>클릭</small>
          </button>
        </div>
        <button className="return-button" type="button" onClick={() => gameBridge.command({ type: "return-base" })}>B · 베이스 즉시 귀환</button>
        {snapshot.bossAvailable && (
          <button className="boss-entry-button" type="button" onClick={() => gameBridge.command({ type: "enter-boss" })}>
            마왕방 입장 <span>준비 완료</span>
          </button>
        )}
      </section>

      <div className="hud-message" aria-live="polite"><span />{snapshot.message}</div>

      {snapshot.bossHp !== null && snapshot.bossMaxHp !== null && (
        <div className="boss-health">
          <span><small>FINAL TARGET</small><strong>마왕 · 종말의 선고자</strong></span>
          <b>{Math.ceil(snapshot.bossHp)} / {snapshot.bossMaxHp}</b>
          <i style={barStyle(snapshot.bossHp, snapshot.bossMaxHp)} />
        </div>
      )}

      <div className="player-status">
        <div className={`player-portrait player-portrait--${heroClass}`}><span>{definition.name.slice(0, 1)}</span><small>LV.{snapshot.level}</small></div>
        <div className="status-bars">
          <div className="hp-line"><span>HP</span><i style={barStyle(snapshot.hp, snapshot.maxHp)} /><b>{Math.ceil(snapshot.hp)} / {snapshot.maxHp}</b></div>
          <div className="xp-line"><span>TEAM EXP</span><i style={barStyle(snapshot.xp, snapshot.xpToNext)} /><b>{snapshot.xp} / {snapshot.xpToNext}</b></div>
        </div>
        <div className="skill-row">
          <span className="skill-slot skill-slot--passive"><i>AUTO</i><b>평타</b><small>자동</small></span>
          <span className="skill-slot"><i>Q</i><b>{definition.skills[0].name}</b><small>{snapshot.qCooldown > 0 ? snapshot.qCooldown.toFixed(1) : "READY"}</small></span>
          <span className="skill-slot"><i>E</i><b>{definition.skills[1].name}</b><small>{snapshot.eCooldown > 0 ? snapshot.eCooldown.toFixed(1) : "READY"}</small></span>
          <span className="skill-slot"><i>SPACE</i><b>회피</b><small>{snapshot.dashCooldown > 0 ? snapshot.dashCooldown.toFixed(1) : "READY"}</small></span>
        </div>
        <div className="power-score"><span>TEAM POWER</span><strong>{snapshot.teamPower}</strong></div>
      </div>
    </div>
  );
}

