"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { EquipmentSummary, GameSnapshot, HeroClassId, PartyMemberSnapshot } from "@/src/game/domain/types";
import { UpgradeDraft } from "./UpgradeDraft";
import type { UpgradeChoice, UpgradeId } from "@/src/game/domain/types";
import { ExplorationHud } from "./hud/ExplorationHud";
import { PhaseHud } from "./hud/PhaseHud";
import { PlayerCommandBar } from "./hud/PlayerCommandBar";
import { InventoryHudButton } from "./hud/InventoryHudButton";
import { PartyVitalsHud } from "./hud/PartyVitalsHud";
import { gameBridge } from "@/src/game/runtime/GameBridge";
import { resolveRoundGateProgress } from "@/src/game/domain/sharedPartyProgress";

const BGM_VOLUME_STORAGE_KEY = "five-days:bgm-volume:v2";
const DEFAULT_BGM_VOLUME = 0;

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
  const initialBgmVolumeRef = useRef(bgmVolume);
  const bgmRef = useRef<HTMLAudioElement | null>(null);
  const gateProgress = resolveRoundGateProgress(snapshot.currentZone, snapshot.roomMap);
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
    const music = new Audio("/audio/music/zombie-rave.mp3");
    music.loop = true;
    music.preload = "auto";
    music.volume = initialBgmVolumeRef.current;
    bgmRef.current = music;
    const play = () => { if (initialBgmVolumeRef.current > 0) void music.play().catch(() => {}); };
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

      <PartyVitalsHud party={party} gateProgress={gateProgress} />

      <InventoryHudButton open={inventoryOpen} onToggle={() => setInventoryOpen((open) => !open)} />

      <ExplorationHud snapshot={snapshot} />

      {snapshot.specialRoom && !terminal && <SpecialRoomPanel snapshot={snapshot} />}

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
            <div className="game-settings-actions">
              <button type="button" className="game-settings-resume" onClick={() => setSettingsOpen(false)}>
                <Image className="game-settings-button-art" src="/images/ui/game-menu/button-resume-v1.png" width={1774} height={887} alt="" aria-hidden="true" />
                <span>게임으로 돌아가기</span>
              </button>
              <button type="button" className="game-settings-exit" onClick={onExit}>
                <Image className="game-settings-button-art" src="/images/ui/game-menu/button-exit-v1.png" width={1774} height={887} alt="" aria-hidden="true" />
                <span>게임 로비로 나가기</span>
              </button>
            </div>
          </section>
        </div>
      )}

      <UpgradeDraft key={upgradeChoices.map((choice) => choice.id).join("|") || "no-upgrade"} choices={upgradeChoices} onChoose={onChoose} />
    </div>
  );
}

const ROOM_COPY: Record<string, { eyebrow: string; title: string }> = {
  shrine: { eyebrow: "TEMPORARY BLESSING", title: "메아리의 성소" },
  trap: { eyebrow: "LOCKDOWN", title: "몬스터 하우스" },
  checkpoint: { eyebrow: "", title: "웨이포인트 활성화" },
  altar: { eyebrow: "PERMANENT THIS RUN", title: "피의 제단" },
};

function SpecialRoomPanel({ snapshot }: { snapshot: GameSnapshot }) {
  const room = snapshot.specialRoom!;
  const copy = ROOM_COPY[room.kind] ?? { eyebrow: "SPECIAL ROOM", title: room.kind };
  type SpecialAction = Extract<Parameters<typeof gameBridge.command>[0], { type: "special-room" }>["action"];
  const send = (action: SpecialAction, payload?: Record<string, string | number>) => gameBridge.command({ type: "special-room", action, payload });
  return (
    <aside className={`special-room-panel is-${room.kind}`} aria-label={copy.title}>
      <header>{copy.eyebrow && <small>{copy.eyebrow}</small>}<strong>{copy.title}</strong></header>
      {room.kind === "shrine" && <><p>{room.state?.shrineClaimedBy ? "성소의 힘이 이미 선택되었습니다." : `${room.state?.shrineKind || "알 수 없는"}의 힘 · 중앙에서 3초간 집중`}</p><progress max={3} value={room.state?.shrineClaimProgress ?? 0} /><button className="special-primary" disabled={Boolean(room.state?.shrineClaimedBy)} onClick={() => send("shrine.claim")}>성소 점유 시작</button></>}
      {room.kind === "trap" && <p className="trap-status">{room.state?.trapPhase === "cleared" ? "봉인이 해제되었습니다." : `${room.state?.trapPhase || "idle"} · ${room.state?.trapDebuff || "진입 시 저주 결정"}`}</p>}
      {room.kind === "checkpoint" && <p>마법진 위에 서서 미니맵의 다른 웨이포인트를 눌러 이동하세요.</p>}
      {room.kind === "altar" && <><p>능력치 하나는 25% 강화되고 다른 하나는 15% 약화됩니다.</p><button className="special-primary" disabled={room.altarAttempts >= 3} onClick={() => send("altar.reroll")}>제단 리롤 · {room.altarAttempts}/3</button></>}
    </aside>
  );
}

function itemRarity(rarity: string): "normal" | "rare" | "epic" | "legendary" | "mythic" {
  if (rarity === "rare" || rarity === "epic" || rarity === "legendary" || rarity === "mythic") return rarity;
  return "normal";
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
  const sendInventoryAction = (action: "equipment.inventory-equip" | "equipment.inventory-discard", inventoryIndex: number) => {
    gameBridge.command({ type: "special-room", action, payload: { inventoryIndex } });
  };
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
      {member.isLocal && <div className="bag-row" aria-label="개인 가방">
        {(member.inventory ?? []).map((item, index) => (
          <div className={`bag-slot ${item ? `rarity-${itemRarity(item.rarity)}` : "rarity-empty"}`} key={index}>
            {item ? <>
              <button type="button" onClick={() => sendInventoryAction("equipment.inventory-equip", index)} title="장착">
                <b>{item.slot}</b><small>{item.rarity}</small>
              </button>
              <span><button type="button" onClick={() => sendInventoryAction("equipment.inventory-discard", index)}>폐기</button></span>
            </> : <button type="button" disabled>빈 칸</button>}
          </div>
        ))}
      </div>}
    </div>
  );
}
