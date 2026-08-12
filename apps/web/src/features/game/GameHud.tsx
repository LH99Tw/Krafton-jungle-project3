"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { EquipmentSummary, GameSnapshot, HeroClassId, PartyMemberSnapshot } from "@/src/game/domain/types";
import { UpgradeDraft } from "./UpgradeDraft";
import type { UpgradeChoice, UpgradeId } from "@/src/game/domain/types";
import { ExplorationHud } from "./hud/ExplorationHud";
import { PhaseHud } from "./hud/PhaseHud";
import { PlayerCommandBar } from "./hud/PlayerCommandBar";
import { TeamGoldHud } from "./hud/TeamGoldHud";
import { PartyVitalsHud } from "./hud/PartyVitalsHud";

const BGM_VOLUME_STORAGE_KEY = "five-days:bgm-volume:v1";
const DEFAULT_BGM_VOLUME = 0.38;

function storedBgmVolume(): number {
  if (typeof window === "undefined") return DEFAULT_BGM_VOLUME;
  const value = Number(window.localStorage.getItem(BGM_VOLUME_STORAGE_KEY));
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_BGM_VOLUME;
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
  terminal = false,
}: {
  snapshot: GameSnapshot;
  heroClass: HeroClassId;
  onExit: () => void;
  upgradeChoices?: UpgradeChoice[];
  onChoose?: (id: UpgradeId) => void;
  terminal?: boolean;
}) {
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bgmVolume, setBgmVolume] = useState(storedBgmVolume);
  const bgmRef = useRef<HTMLAudioElement | null>(null);
  const editorWorld = snapshot.worldMode === "editor";
  const gateGoal = editorWorld
    ? snapshot.roomMap.filter((room) => room.type === "gate").length
    : 3;
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
      respawnRemaining: 0,
      roomId: snapshot.currentRoomId,
      x: 0,
      y: 0,
      aim: 0,
      attackSequence: 0,
      attackTargetId: "",
      attackCritical: false,
      isLocal: true,
      equipment: snapshot.equipment,
    }];

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat || terminal) return;
      event.preventDefault();
      setSettingsOpen((open) => !open);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [terminal]);

  useEffect(() => {
    const music = new Audio("/audio/music/expedition-tension-v1.ogg");
    music.loop = true;
    music.preload = "auto";
    music.volume = bgmVolume;
    bgmRef.current = music;
    const play = () => { if (bgmVolume > 0) void music.play().catch(() => {}); };
    play();
    window.addEventListener("pointerdown", play, { once: true });
    window.addEventListener("keydown", play, { once: true });
    return () => {
      window.removeEventListener("pointerdown", play);
      window.removeEventListener("keydown", play);
      music.pause();
      music.src = "";
      bgmRef.current = null;
    };
  // The audio element belongs to the game HUD lifetime; volume updates are handled separately below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    window.localStorage.setItem(BGM_VOLUME_STORAGE_KEY, String(bgmVolume));
    const music = bgmRef.current;
    if (music) music.volume = bgmVolume;
    if (music && bgmVolume > 0 && music.paused) void music.play().catch(() => {});
    if (music && bgmVolume === 0) music.pause();
  }, [bgmVolume]);

  return (
    <div className="hud-root">
      <PhaseHud
        phase={snapshot.phase}
        phaseLabel={snapshot.phaseLabel}
        day={snapshot.day}
        remaining={snapshot.phaseRemaining}
      />

      {inventoryOpen && !terminal && (
        <div id="party-inventory" className="inventory-popup" role="dialog" aria-label="공유 인벤토리">
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

      <PartyVitalsHud party={party} gatesDestroyed={snapshot.gatesDestroyed} gateGoal={gateGoal} />

      <TeamGoldHud
        gold={snapshot.gold}
        inventoryOpen={inventoryOpen}
        onInventoryToggle={() => setInventoryOpen((open) => !open)}
      />

      <ExplorationHud snapshot={snapshot} />

      {snapshot.message.trim() && <HudMessage key={snapshot.message} message={snapshot.message.trim()} />}

      {snapshot.bossHp !== null && snapshot.bossMaxHp !== null && (
        <div className="boss-health">
          <span><small>FINAL TARGET</small><strong>마왕 · 종말의 선고자</strong></span>
          <b>{Math.ceil(snapshot.bossHp)} / {snapshot.bossMaxHp}</b>
          <i style={barStyle(snapshot.bossHp, snapshot.bossMaxHp)} />
        </div>
      )}

      <PlayerCommandBar
        snapshot={snapshot}
        heroClass={heroClass}
        upgradeDraftOpen={upgradeChoices.length > 0}
      />

      {settingsOpen && !terminal && (
        <div className="modal-backdrop game-settings-backdrop" role="dialog" aria-modal="true" aria-labelledby="game-settings-title">
          <section className="game-settings-modal">
            <Image className="game-settings-panel-art" src="/images/ui/result-screen/settings-panel.png" width={934} height={1550} alt="" aria-hidden="true" priority />
            <span>EXPEDITION MENU · ESC</span>
            <h2 id="game-settings-title">원정 설정</h2>
            <p>전투는 계속 진행됩니다. 퇴장하면 현재 캐릭터의 장비와 능력치를 이어받은 AI가 원정에 참전합니다.</p>
            <label className="game-settings-volume">
              <span><b>배경음</b><output>{Math.round(bgmVolume * 100)}%</output></span>
              <input type="range" min="0" max="100" step="1" value={Math.round(bgmVolume * 100)} aria-label="배경음 음량" onChange={(event) => setBgmVolume(Number(event.target.value) / 100)} />
              <small>{bgmVolume === 0 ? "음소거" : "긴박한 원정 음악"}</small>
            </label>
            <button type="button" className="game-settings-exit" onClick={onExit}>
              <span>게임 로비로 나가기</span>
            </button>
          </section>
        </div>
      )}

      <UpgradeDraft key={upgradeChoices.map((choice) => choice.id).join("|") || "no-upgrade"} choices={upgradeChoices} onChoose={onChoose} />
    </div>
  );
}

function HudMessage({ message }: { message: string }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timeout = window.setTimeout(() => setVisible(false), 3000);
    return () => window.clearTimeout(timeout);
  }, []);

  if (!visible) return null;
  return (
    <div className="hud-message" role="status" aria-live="polite" aria-atomic="true">
      <span aria-hidden="true" />{message}
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
