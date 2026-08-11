"use client";

import { useState } from "react";
import { CLASS_DEFINITIONS } from "@/src/game/content/classes";
import { BUILDINGS } from "@/src/game/content/balance";
import type { EquipmentSummary, GameSnapshot, HeroClassId, PartyMemberSnapshot } from "@/src/game/domain/types";
import { gameBridge } from "@/src/game/runtime/GameBridge";
import { RoomMiniMap } from "./RoomMiniMap";
import { UpgradeDraft } from "./UpgradeDraft";
import type { UpgradeChoice, UpgradeId } from "@/src/game/domain/types";

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
  upgradeChoices = [],
  onChoose = () => {},
}: {
  snapshot: GameSnapshot;
  heroClass: HeroClassId;
  onExit: () => void;
  upgradeChoices?: UpgradeChoice[];
  onChoose?: (id: UpgradeId) => void;
}) {
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const definition = CLASS_DEFINITIONS[heroClass];
  const phaseWarning = snapshot.phase === "night" || snapshot.phase === "boss";
  const party = snapshot.party.length > 0
    ? snapshot.party
    : [{
      userId: "local",
      displayName: "나",
      heroClass,
      hp: snapshot.hp,
      maxHp: snapshot.maxHp,
      level: snapshot.level,
      teamPower: snapshot.teamPower,
      ready: true,
      connected: true,
      alive: snapshot.hp > 0,
      roomId: snapshot.currentRoomId,
      x: 0,
      y: 0,
      aim: 0,
      isLocal: true,
      equipment: snapshot.equipment,
    }];

  return (
    <div className="hud-root">
      <div className={`phase-banner ${phaseWarning ? "is-danger" : ""}`}>
        <div className="day-pips" aria-label={`${snapshot.day}일차`}>
          {[1, 2, 3, 4, 5].map((day) => <span key={day} className={day <= snapshot.day ? "active" : ""}>{day}</span>)}
        </div>
        <div className="phase-copy"><small>DAY {snapshot.day} / 05</small><strong>{snapshot.phaseLabel}</strong></div>
        <time>{snapshot.phase === "boss" ? "FINAL" : formatTime(snapshot.phaseRemaining)}</time>
      </div>

      <button
        type="button"
        className="inventory-toggle"
        aria-label="파티 인벤토리"
        onClick={() => setInventoryOpen((open) => !open)}
      >
        🎒 인벤토리
      </button>

      {inventoryOpen && (
        <div className="inventory-popup" role="dialog" aria-label="공유 인벤토리">
          <div className="inventory-popup-head">
            <span>PARTY INVENTORY · 공유 장비</span>
            <button type="button" onClick={() => setInventoryOpen(false)}>닫기</button>
          </div>
          <div className="inventory-party-grid">
            {party.map((member) => (
              <InventoryMember key={member.userId} member={member} equipment={member.equipment} />
            ))}
          </div>
        </div>
      )}

      <section className="party-panel hud-panel" aria-label="파티 상태">
        <div className="hud-panel-title"><span>EXPEDITION PARTY</span><button type="button" onClick={onExit}>나가기</button></div>
        {party.map((partyMember) => {
          const member = CLASS_DEFINITIONS[partyMember.heroClass];
          return (
            <div className={`party-member ${partyMember.isLocal ? "is-you" : ""} ${partyMember.connected ? "" : "is-offline"}`} key={partyMember.userId}>
              <span className={`party-avatar party-avatar--${partyMember.heroClass}`}>{member.name.slice(0, 1)}</span>
              <div><strong>{partyMember.displayName}{partyMember.isLocal ? " · YOU" : ""}</strong><span className="micro-bar" style={barStyle(partyMember.hp, partyMember.maxHp)} /></div>
              <small>{partyMember.connected ? Math.ceil(partyMember.hp) : "OFF"}</small>
            </div>
          );
        })}
        <div className="objective-list">
          <span><i className={snapshot.gatesDestroyed >= 3 ? "done" : ""} /> 게이트 파괴 <b>{snapshot.gatesDestroyed}/3</b></span>
          <span><i className={snapshot.roomsExplored >= 15 ? "done" : ""} /> 구역 탐색 <b>{snapshot.roomsExplored}/15</b></span>
        </div>
      </section>

      <section className="team-gold-panel hud-panel" aria-label="팀 골드">
        <div className="resource-row"><span>TEAM GOLD</span><strong>{snapshot.gold}<small>G</small></strong></div>
      </section>

      <section className="bottom-right-panel hud-panel" aria-label="탐색 지도 및 기지 내구도">
        <RoomMiniMap rooms={snapshot.roomMap} zone={snapshot.currentZone} embed={true} />

        <div className="base-health">
          <span><b>베이스 내구도</b><small>{Math.ceil(snapshot.baseHp)} / {snapshot.baseMaxHp}</small></span>
          <span className="base-bar" style={barStyle(snapshot.baseHp, snapshot.baseMaxHp)} />
        </div>
        {snapshot.buildSupported && snapshot.inBuildZone ? (
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
        ) : <p className="build-zone-hint">{snapshot.buildSupported
          ? "베이스 건설 구획 안에서만 시설 메뉴가 열립니다."
          : "멀티플레이 건설은 서버 검증 통합 대기 중입니다."}</p>}
        {snapshot.waypoint.nearby && (
          <button className="return-button" type="button" onClick={() => gameBridge.command({
            type: "travel",
            waypointId: snapshot.waypoint.id ?? "",
            destinationId: snapshot.waypoint.destinationId,
          })}>
            웨이포인트 집결 · {snapshot.waypoint.presentPlayers}/{snapshot.waypoint.requiredPlayers}
          </button>
        )}
        {snapshot.waypoint.holdProgress > 0 && <span className="waypoint-progress"><i style={{ width: `${snapshot.waypoint.holdProgress * 100}%` }} /></span>}
        {snapshot.bossAvailable && (
          <button className="boss-entry-button" type="button" onClick={() => gameBridge.command({ type: "travel", waypointId: snapshot.waypoint.id ?? "", destinationId: snapshot.waypoint.destinationId })}>
            마왕방 집결 <span>전원 5초 점유</span>
          </button>
        )}
        {snapshot.equipment.length > 0 && (
          <div className="equipment-strip" aria-label="장착 장비">
            {snapshot.equipment.map((item) => <span className={`rarity-${item.rarity}`} key={item.slot}><small>{item.slot}</small><b>{item.name}</b></span>)}
          </div>
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

      <div className={`player-status ${upgradeChoices.length > 0 ? "has-upgrade-draft" : ""}`}>
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

      <UpgradeDraft choices={upgradeChoices} onChoose={onChoose} />
    </div>
  );
}

const SLOTS: EquipmentSummary["slot"][] = ["weapon", "armor", "accessory"];

function InventoryMember({ member, equipment }: { member: PartyMemberSnapshot; equipment: EquipmentSummary[] }) {
  const bySlot = new Map(equipment.map((item) => [item.slot, item]));
  return (
    <div className={`inventory-member ${member.connected ? "" : "is-offline"}`}>
      <div className="inventory-member-head">
        <strong>{member.displayName}{member.isLocal ? " · YOU" : ""}</strong>
        <small>{member.connected ? `HP ${Math.ceil(member.hp)}` : "OFF"}</small>
      </div>
      <div className="inventory-slots">
        {SLOTS.map((slot) => {
          const item = bySlot.get(slot);
          return item ? (
            <span className={`inventory-slot rarity-${item.rarity}`} key={slot}>
              <small>{slot}</small><b>{item.name}</b><em>{item.power}P</em>
            </span>
          ) : (
            <span className="inventory-slot is-empty" key={slot}><small>{slot}</small><b>—</b></span>
          );
        })}
      </div>
    </div>
  );
}
