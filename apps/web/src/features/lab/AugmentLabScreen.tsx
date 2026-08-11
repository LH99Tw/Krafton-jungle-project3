"use client";

import { useCallback, useEffect, useState } from "react";
import { FantasyButton } from "@/src/components/ui/FantasyButton";
import type { HeroClassId } from "@five-days/protocol";
import "./augmentLab.css";

export type TargetTier = "mob" | "elite" | "boss";

export type LabAugmentStats = {
  attackPowerPercent: number;
  attackSpeedPercent: number;
  critChancePercent: number;
  critDamagePercent: number;
  skillHastePercent: number;
  skillPowerPercent: number;
  bossDamagePercent: number;
  consecutiveHitBonusPercent: number;
  attackAreaPercent: number;
  hasSkillEcho: boolean;
  hasOvercharge: boolean;
  hasChainBlast: boolean;
};

const DEFAULT_STATS: LabAugmentStats = {
  attackPowerPercent: 0,
  attackSpeedPercent: 0,
  critChancePercent: 10,
  critDamagePercent: 150,
  skillHastePercent: 0,
  skillPowerPercent: 0,
  bossDamagePercent: 0,
  consecutiveHitBonusPercent: 0,
  attackAreaPercent: 0,
  hasSkillEcho: false,
  hasOvercharge: false,
  hasChainBlast: false,
};

const PRESETS: Record<string, { label: string; stats: LabAugmentStats }> = {
  default: { label: "기본 상태 (Clean)", stats: DEFAULT_STATS },
  cooldown: {
    label: "스킬 쿨감 80%",
    stats: { ...DEFAULT_STATS, skillHastePercent: 80, skillPowerPercent: 40, hasSkillEcho: true },
  },
  crit: {
    label: "치명타 100% / 크뎀 350%",
    stats: { ...DEFAULT_STATS, critChancePercent: 100, critDamagePercent: 350, attackPowerPercent: 50 },
  },
  bossSlayer: {
    label: "거물 사냥꾼 150%",
    stats: { ...DEFAULT_STATS, bossDamagePercent: 150, attackPowerPercent: 60, hasOvercharge: true },
  },
  maxed: {
    label: "최고 등급 풀 증강",
    stats: {
      attackPowerPercent: 120,
      attackSpeedPercent: 80,
      critChancePercent: 80,
      critDamagePercent: 300,
      skillHastePercent: 60,
      skillPowerPercent: 100,
      bossDamagePercent: 100,
      consecutiveHitBonusPercent: 50,
      attackAreaPercent: 50,
      hasSkillEcho: true,
      hasOvercharge: true,
      hasChainBlast: true,
    },
  },
};

const TARGET_CONFIGS: Record<TargetTier, { name: string; maxHp: number; defense: number; icon: string; description: string }> = {
  mob: { name: "1단계: 하급 잡몹 (Slime Mob)", maxHp: 500, defense: 0, icon: "🧟", description: "방어력 0 / 일반 몬스터" },
  elite: { name: "2단계: 게이트 엘리트 몬스터", maxHp: 4000, defense: 18, icon: "👹", description: "방어력 18 / 엘리트 수호 몬스터 (거물 피해 적용)" },
  boss: { name: "3단계: 마왕 (Demon King Boss)", maxHp: 32000, defense: 40, icon: "👑", description: "방어력 40 / 3구역 대마왕 (거물/보스 피해 극대화)" },
};

type DamagePopup = {
  id: number;
  text: string;
  damage: number;
  isCrit: boolean;
  isBossBonus: boolean;
  x: number;
  y: number;
};

type CombatLogEntry = {
  timestamp: string;
  type: string;
  damage: number;
  isCrit: boolean;
  text: string;
};

export function AugmentLabScreen({ onBack }: { onBack: () => void }) {
  const [heroClass, setHeroClass] = useState<HeroClassId>("mage");
  const [targetTier, setTargetTier] = useState<TargetTier>("boss");
  const [stats, setStats] = useState<LabAugmentStats>(DEFAULT_STATS);

  const targetConfig = TARGET_CONFIGS[targetTier];
  const [targetHp, setTargetHp] = useState(targetConfig.maxHp);
  const [isDead, setIsDead] = useState(false);
  const [consecutiveHits, setConsecutiveHits] = useState(0);

  const [autoAttackActive, setAutoAttackActive] = useState(false);
  const [qCooldown, setQCooldown] = useState(0);
  const [eCooldown, setECooldown] = useState(0);

  const [totalDamage, setTotalDamage] = useState(0);
  const [totalHits, setTotalHits] = useState(0);
  const [critHits, setCritHits] = useState(0);
  const [maxHit, setMaxHit] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [killTime, setKillTime] = useState<number | null>(null);

  const [popups, setPopups] = useState<DamagePopup[]>([]);
  const [logs, setLogs] = useState<CombatLogEntry[]>([]);

  useEffect(() => {
    setTargetHp(TARGET_CONFIGS[targetTier].maxHp);
    setIsDead(false);
    setConsecutiveHits(0);
    setKillTime(null);
  }, [targetTier]);

  useEffect(() => {
    if (!startTime || isDead) return;
    const interval = setInterval(() => {
      setElapsedSeconds(Number(((Date.now() - startTime) / 1000).toFixed(1)));
    }, 100);
    return () => clearInterval(interval);
  }, [startTime, isDead]);

  useEffect(() => {
    const interval = setInterval(() => {
      setQCooldown((c) => Math.max(0, c - 0.1));
      setECooldown((c) => Math.max(0, c - 0.1));
    }, 100);
    return () => clearInterval(interval);
  }, []);

  const resetTarget = useCallback(() => {
    setTargetHp(TARGET_CONFIGS[targetTier].maxHp);
    setIsDead(false);
    setConsecutiveHits(0);
    setTotalDamage(0);
    setTotalHits(0);
    setCritHits(0);
    setMaxHit(0);
    setStartTime(null);
    setElapsedSeconds(0);
    setKillTime(null);
    setPopups([]);
    setLogs([]);
  }, [targetTier]);

  const applyDamage = useCallback(
    (sourceName: string, baseDamage: number, isSkill = false) => {
      if (isDead) return;

      const now = Date.now();
      if (!startTime) setStartTime(now);

      const attackPowerMult = 1 + stats.attackPowerPercent / 100;
      const skillPowerMult = isSkill ? 1 + stats.skillPowerPercent / 100 : 1;
      const bossMult = targetTier !== "mob" ? 1 + stats.bossDamagePercent / 100 : 1;
      const consecutiveMult = Math.min(1.5, 1 + (consecutiveHits * stats.consecutiveHitBonusPercent) / 100);
      const defenseMult = 100 / (100 + targetConfig.defense);

      const rollCrit = Math.random() * 100 < stats.critChancePercent;
      const critMult = rollCrit ? stats.critDamagePercent / 100 : 1;

      let rawDamage = baseDamage * attackPowerMult * skillPowerMult * bossMult * consecutiveMult * critMult;

      if (stats.hasOvercharge && !isSkill && consecutiveHits > 0 && consecutiveHits % 4 === 0) {
        rawDamage *= 2.2;
      }

      const finalDamage = Math.max(1, Math.round(rawDamage * defenseMult));

      setConsecutiveHits((prev) => prev + 1);
      setTotalDamage((prev) => prev + finalDamage);
      setTotalHits((prev) => prev + 1);
      if (rollCrit) setCritHits((prev) => prev + 1);
      setMaxHit((prev) => Math.max(prev, finalDamage));

      setTargetHp((prev) => {
        const next = Math.max(0, prev - finalDamage);
        if (next === 0 && !isDead) {
          setIsDead(true);
          const duration = Number(((now - (startTime || now)) / 1000).toFixed(2));
          setKillTime(duration > 0 ? duration : 0.1);
        }
        return next;
      });

      const popupId = Math.random();
      const popupX = Math.floor(Math.random() * 120) - 60;
      const popupY = Math.floor(Math.random() * 60) - 30;
      setPopups((prev) => [
        ...prev.slice(-15),
        {
          id: popupId,
          damage: finalDamage,
          isCrit: rollCrit,
          isBossBonus: targetTier !== "mob" && stats.bossDamagePercent > 0,
          text: rollCrit ? `💥 CRIT! ${finalDamage.toLocaleString()}` : `${finalDamage.toLocaleString()}`,
          x: popupX,
          y: popupY,
        },
      ]);

      const timeStr = new Date().toLocaleTimeString();
      const logText = `${sourceName}: ${finalDamage.toLocaleString()} 피해 ${rollCrit ? "⚡ [치명타!]" : ""} ${
        targetTier !== "mob" && stats.bossDamagePercent > 0 ? "👑 [거물보너스]" : ""
      }`;
      setLogs((prev) => [{ timestamp: timeStr, type: sourceName, damage: finalDamage, isCrit: rollCrit, text: logText }, ...prev.slice(0, 49)]);

      if (isSkill && stats.hasSkillEcho) {
        setTimeout(() => {
          const echoDamage = Math.round(finalDamage * 0.55);
          setTargetHp((prev) => Math.max(0, prev - echoDamage));
          setTotalDamage((prev) => prev + echoDamage);
          setLogs((prev) => [
            { timestamp: new Date().toLocaleTimeString(), type: "주문 메아리", damage: echoDamage, isCrit: false, text: `✨ [주문 메아리] 추가 여진: ${echoDamage.toLocaleString()}` },
            ...prev.slice(0, 49),
          ]);
        }, 350);
      }
    },
    [consecutiveHits, isDead, startTime, stats, targetConfig.defense, targetTier],
  );

  const triggerAutoAttack = useCallback(() => {
    const baseAttack = heroClass === "swordsman" ? 65 : heroClass === "archer" ? 50 : 60;
    applyDamage("기본 공격", baseAttack, false);
  }, [applyDamage, heroClass]);

  const triggerQSkill = useCallback(() => {
    if (qCooldown > 0) return;
    const baseSkill = heroClass === "swordsman" ? 220 : heroClass === "archer" ? 180 : 250;
    const cd = Math.max(1, 4 * (1 - stats.skillHastePercent / 100));
    setQCooldown(cd);
    applyDamage("Q 스킬", baseSkill, true);
  }, [applyDamage, heroClass, qCooldown, stats.skillHastePercent]);

  const triggerESkill = useCallback(() => {
    if (eCooldown > 0) return;
    const baseSkill = heroClass === "swordsman" ? 380 : heroClass === "archer" ? 320 : 420;
    const cd = Math.max(1.5, 8 * (1 - stats.skillHastePercent / 100));
    setECooldown(cd);
    applyDamage("E 필살기", baseSkill, true);
  }, [applyDamage, heroClass, eCooldown, stats.skillHastePercent]);

  useEffect(() => {
    if (!autoAttackActive || isDead) return;
    const baseInterval = 1000 / (1 + stats.attackSpeedPercent / 100);
    const interval = setInterval(() => {
      triggerAutoAttack();
    }, Math.max(150, baseInterval));
    return () => clearInterval(interval);
  }, [autoAttackActive, isDead, stats.attackSpeedPercent, triggerAutoAttack]);

  const currentDps = elapsedSeconds > 0 ? Math.round(totalDamage / elapsedSeconds) : 0;
  const actualCritRate = totalHits > 0 ? Math.round((critHits / totalHits) * 100) : 0;
  const hpPercent = Math.max(0, Math.round((targetHp / targetConfig.maxHp) * 100));

  return (
    <main className="augment-lab-screen">
      <header className="lab-header">
        <div className="lab-title">
          <button type="button" className="lab-back-btn" onClick={onBack}>
            ◀ 메인 화면으로
          </button>
          <div>
            <h1>🧪 증강 밸런스 실험실 (Augment Balance Laboratory)</h1>
            <p>증강 능력치를 실시간 튜닝하고 잡몹·몬스터·보스 단계별 피해량과 처치 속도를 바로 테스트하세요.</p>
          </div>
        </div>

        <div className="lab-hero-select">
          <span>영웅 직업:</span>
          {(["mage", "swordsman", "archer"] as const).map((cls) => (
            <button key={cls} type="button" className={`hero-tab ${heroClass === cls ? "active" : ""}`} onClick={() => setHeroClass(cls)}>
              {cls === "mage" ? "🧙 마법사" : cls === "swordsman" ? "🗡️ 검사" : "🏹 궁수"}
            </button>
          ))}
        </div>

        <div className="lab-presets">
          <span>밸런스 프리셋:</span>
          {Object.entries(PRESETS).map(([key, preset]) => (
            <button key={key} type="button" className="preset-btn" onClick={() => setStats(preset.stats)}>
              {preset.label}
            </button>
          ))}
        </div>
      </header>

      <div className="lab-workspace">
        <aside className="lab-tuner-panel">
          <h2>⚙️ 증강 성능 튜닝 (Stat Tuner)</h2>

          <div className="tuner-group">
            <h3>공용 기본 증강</h3>

            <label className="stat-slider">
              <div>
                <span>⚔️ 공격력 (Power)</span>
                <strong>+{stats.attackPowerPercent}%</strong>
              </div>
              <input type="range" min="0" max="200" step="5" value={stats.attackPowerPercent} onChange={(e) => setStats({ ...stats, attackPowerPercent: Number(e.target.value) })} />
            </label>

            <label className="stat-slider">
              <div>
                <span>⚡ 공격 속도 (Haste)</span>
                <strong>+{stats.attackSpeedPercent}%</strong>
              </div>
              <input type="range" min="0" max="200" step="5" value={stats.attackSpeedPercent} onChange={(e) => setStats({ ...stats, attackSpeedPercent: Number(e.target.value) })} />
            </label>

            <label className="stat-slider">
              <div>
                <span>🎯 치명타 확률 (Crit Rate)</span>
                <strong>{stats.critChancePercent}%</strong>
              </div>
              <input type="range" min="0" max="100" step="5" value={stats.critChancePercent} onChange={(e) => setStats({ ...stats, critChancePercent: Number(e.target.value) })} />
            </label>

            <label className="stat-slider">
              <div>
                <span>💥 치명타 피해 (Crit Dmg)</span>
                <strong>{stats.critDamagePercent}%</strong>
              </div>
              <input type="range" min="150" max="500" step="10" value={stats.critDamagePercent} onChange={(e) => setStats({ ...stats, critDamagePercent: Number(e.target.value) })} />
            </label>

            <label className="stat-slider">
              <div>
                <span>⏱️ 스킬 쿨타임 감소 (Skill Haste)</span>
                <strong>-{stats.skillHastePercent}%</strong>
              </div>
              <input type="range" min="0" max="80" step="5" value={stats.skillHastePercent} onChange={(e) => setStats({ ...stats, skillHastePercent: Number(e.target.value) })} />
            </label>

            <label className="stat-slider">
              <div>
                <span>✨ 스킬 위력 (Skill Power)</span>
                <strong>+{stats.skillPowerPercent}%</strong>
              </div>
              <input type="range" min="0" max="200" step="5" value={stats.skillPowerPercent} onChange={(e) => setStats({ ...stats, skillPowerPercent: Number(e.target.value) })} />
            </label>

            <label className="stat-slider highlight-slider">
              <div>
                <span>👑 거물/보스 추가 피해 (Boss Slayer)</span>
                <strong>+{stats.bossDamagePercent}%</strong>
              </div>
              <input type="range" min="0" max="200" step="5" value={stats.bossDamagePercent} onChange={(e) => setStats({ ...stats, bossDamagePercent: Number(e.target.value) })} />
            </label>

            <label className="stat-slider">
              <div>
                <span>🔥 연속 타격 피해 (Momentum)</span>
                <strong>+{stats.consecutiveHitBonusPercent}% /hit</strong>
              </div>
              <input type="range" min="0" max="100" step="5" value={stats.consecutiveHitBonusPercent} onChange={(e) => setStats({ ...stats, consecutiveHitBonusPercent: Number(e.target.value) })} />
            </label>
          </div>

          <div className="tuner-group">
            <h3>🌟 클래스 전설/마일스톤 증강</h3>
            <label className="checkbox-option">
              <input type="checkbox" checked={stats.hasSkillEcho} onChange={(e) => setStats({ ...stats, hasSkillEcho: e.target.checked })} />
              <span>✨ 주문 메아리 (스킬 55% 여진 발동)</span>
            </label>
            <label className="checkbox-option">
              <input type="checkbox" checked={stats.hasOvercharge} onChange={(e) => setStats({ ...stats, hasOvercharge: e.target.checked })} />
              <span>⚡ 과충전 (4번째 공격 +120% 폭딜)</span>
            </label>
            <label className="checkbox-option">
              <input type="checkbox" checked={stats.hasChainBlast} onChange={(e) => setStats({ ...stats, hasChainBlast: e.target.checked })} />
              <span>🌀 체인 붕괴 (주변 60% 폭발 연계)</span>
            </label>
          </div>
        </aside>

        <section className="lab-arena-panel">
          <div className="target-selector">
            <span>테스트 타겟 단계:</span>
            {(["mob", "elite", "boss"] as const).map((tier) => (
              <button key={tier} type="button" className={`target-tab ${targetTier === tier ? "active" : ""}`} onClick={() => setTargetTier(tier)}>
                {TARGET_CONFIGS[tier].icon} {TARGET_CONFIGS[tier].name}
              </button>
            ))}
          </div>

          <div className="arena-viewport">
            <div className="target-card">
              <div className="target-avatar">{targetConfig.icon}</div>
              <div className="target-info">
                <h3>{targetConfig.name}</h3>
                <p>{targetConfig.description}</p>
                <div className="target-hp-bar">
                  <div className="hp-fill" style={{ width: `${hpPercent}%` }} />
                  <span className="hp-text">
                    {targetHp.toLocaleString()} / {targetConfig.maxHp.toLocaleString()} ({hpPercent}%)
                  </span>
                </div>
              </div>
            </div>

            <div className="popups-overlay">
              {popups.map((p) => (
                <div key={p.id} className={`damage-popup ${p.isCrit ? "crit" : ""} ${p.isBossBonus ? "boss-bonus" : ""}`} style={{ transform: `translate(${p.x}px, ${p.y}px)` }}>
                  {p.text}
                </div>
              ))}
            </div>

            {isDead && (
              <div className="target-dead-banner">
                <h2>☠️ TARGET ELIMINATED!</h2>
                <p>처치 완료 소요 시간: <strong>{killTime ?? elapsedSeconds}초</strong></p>
                <button type="button" className="respawn-btn" onClick={resetTarget}>
                  🔄 타겟 다시 생성 (Respawn)
                </button>
              </div>
            )}
          </div>

          <div className="arena-controls">
            <FantasyButton variant="primary" size="large" onClick={triggerAutoAttack} disabled={isDead}>
              ⚔️ 기본 공격
            </FantasyButton>
            <FantasyButton variant="secondary" size="large" onClick={triggerQSkill} disabled={isDead || qCooldown > 0}>
              💥 Q 스킬 {qCooldown > 0 ? `(${qCooldown.toFixed(1)}s)` : ""}
            </FantasyButton>
            <FantasyButton variant="secondary" size="large" onClick={triggerESkill} disabled={isDead || eCooldown > 0}>
              ⚡ E 필살기 {eCooldown > 0 ? `(${eCooldown.toFixed(1)}s)` : ""}
            </FantasyButton>
            <button type="button" className={`auto-toggle-btn ${autoAttackActive ? "active" : ""}`} onClick={() => setAutoAttackActive(!autoAttackActive)}>
              {autoAttackActive ? "⏹️ 자동 연속 공격 중지" : "▶️ 자동 연속 공격 (Auto)"}
            </button>
            <button type="button" className="reset-btn" onClick={resetTarget}>
              🔄 초기화
            </button>
          </div>
        </section>

        <aside className="lab-analytics-panel">
          <h2>📊 밸런스 측정 및 분석</h2>

          <div className="metrics-grid">
            <div className="metric-box highlight-metric">
              <span className="metric-title">실시간 DPS</span>
              <strong className="metric-value">{currentDps.toLocaleString()}</strong>
              <span className="metric-unit">damage / sec</span>
            </div>

            <div className="metric-box">
              <span className="metric-title">처치 소요 시간 (TTK)</span>
              <strong className="metric-value">{isDead ? `${killTime}초` : `${elapsedSeconds}초`}</strong>
              <span className="metric-unit">{isDead ? "최종 처치 완료" : "측정 진행 중"}</span>
            </div>

            <div className="metric-box">
              <span className="metric-title">최대 단일 피해</span>
              <strong className="metric-value">{maxHit.toLocaleString()}</strong>
              <span className="metric-unit">Max Hit Damage</span>
            </div>

            <div className="metric-box">
              <span className="metric-title">실제 크리티컬 발생률</span>
              <strong className="metric-value">{actualCritRate}%</strong>
              <span className="metric-unit">{critHits} / {totalHits} hits</span>
            </div>
          </div>

          <div className="combat-log-section">
            <div className="log-header">
              <h3>📜 실시간 전투 로그</h3>
              <button type="button" className="clear-log-btn" onClick={() => setLogs([])}>
                로그 지우기
              </button>
            </div>
            <div className="log-list">
              {logs.length === 0 ? (
                <p className="log-empty">공격 버튼을 누르거나 자동 연속 공격을 시작하세요.</p>
              ) : (
                logs.map((log, idx) => (
                  <div key={idx} className={`log-item ${log.isCrit ? "crit-log" : ""}`}>
                    <span className="log-time">{log.timestamp}</span>
                    <span className="log-text">{log.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}