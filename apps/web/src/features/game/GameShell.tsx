"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { GameCanvas } from "@/src/game/client/GameCanvas";
import { CLASS_DEFINITIONS, CLASS_ORDER } from "@/src/game/content/classes";
import {
  EMPTY_SNAPSHOT,
  type GameResult,
  type GameSnapshot,
  type GameStartOptions,
  type HeroClassId,
  type SessionMode,
  type UpgradeChoice,
} from "@/src/game/domain/types";
import { gameBridge } from "@/src/game/runtime/GameBridge";
import { colyseusTransport, type NetworkStatus } from "@/src/game/transport/ColyseusTransport";
import { Guestbook } from "../guestbook/Guestbook";
import { GameHud } from "./GameHud";
import { ResultOverlay } from "./ResultOverlay";
import { UpgradeDraft } from "./UpgradeDraft";

export type Viewer = {
  userId: string;
  displayName: string;
  email: string;
  csrfToken: string;
} | null;

type Screen = "briefing" | "playing";

export function GameShell({ viewer, gameServerUrl }: { viewer: Viewer; gameServerUrl: string }) {
  const router = useRouter();
  const [screen, setScreen] = useState<Screen>("briefing");
  const [selectedClass, setSelectedClass] = useState<HeroClassId>("swordsman");
  const [sessionMode, setSessionMode] = useState<SessionMode>("prototype");
  const [difficulty, setDifficulty] = useState<GameStartOptions["difficulty"]>("normal");
  const [activeOptions, setActiveOptions] = useState<GameStartOptions | null>(null);
  const [runKey, setRunKey] = useState(0);
  const [snapshot, setSnapshot] = useState<GameSnapshot>(EMPTY_SNAPSHOT);
  const [upgradeChoices, setUpgradeChoices] = useState<UpgradeChoice[]>([]);
  const [result, setResult] = useState<GameResult | null>(null);
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus>("idle");
  const [networkError, setNetworkError] = useState("");

  useEffect(() => {
    const offSnapshot = gameBridge.on("snapshot", setSnapshot);
    const offUpgrade = gameBridge.on("upgrade", setUpgradeChoices);
    const offResult = gameBridge.on("result", (gameResult) => {
      setResult(gameResult);
    });
    return () => {
      offSnapshot();
      offUpgrade();
      offResult();
      colyseusTransport.disconnect();
    };
  }, []);

  const beginRun = useCallback(async () => {
    if (gameServerUrl) {
      if (!viewer) {
        router.push("/api/auth/login?returnTo=%2F");
        return;
      }
      setNetworkStatus("connecting");
      setNetworkError("");
      try {
        await colyseusTransport.connect({
          serverUrl: gameServerUrl,
          csrfToken: viewer.csrfToken,
          options: { heroClass: selectedClass, sessionMode, difficulty },
        });
        setNetworkStatus("connected");
      } catch (error) {
        setNetworkStatus("error");
        setNetworkError(error instanceof Error ? error.message : "게임 서버에 연결하지 못했습니다.");
        return;
      }
    }
    setSnapshot(EMPTY_SNAPSHOT);
    setUpgradeChoices([]);
    setResult(null);
    setActiveOptions({ heroClass: selectedClass, sessionMode, difficulty });
    setRunKey((value) => value + 1);
    setScreen("playing");
  }, [difficulty, gameServerUrl, router, selectedClass, sessionMode, viewer]);

  const retryRun = useCallback(() => {
    setSnapshot(EMPTY_SNAPSHOT);
    setUpgradeChoices([]);
    setResult(null);
    setRunKey((value) => value + 1);
  }, []);

  const returnToBriefing = useCallback(() => {
    colyseusTransport.disconnect();
    setNetworkStatus("disconnected");
    setScreen("briefing");
    setActiveOptions(null);
    setResult(null);
    setUpgradeChoices([]);
    setSnapshot(EMPTY_SNAPSHOT);
  }, []);

  const chooseUpgrade = useCallback((upgradeId: UpgradeChoice["id"]) => {
    gameBridge.command({ type: "choose-upgrade", upgradeId });
    setUpgradeChoices([]);
  }, []);

  const selectedDefinition = CLASS_DEFINITIONS[selectedClass];
  const modeLabel = sessionMode === "prototype" ? "약 8분" : "25분";
  const headerIdentity = useMemo(
    () => viewer?.displayName ?? "로그인 전 용사",
    [viewer],
  );

  if (screen === "playing" && activeOptions) {
    return (
      <main className="play-screen">
        <div className="network-status" role="status">게임 서버 · {networkStatus === "connected" ? "연결됨" : networkStatus}</div>
        <GameCanvas key={runKey} options={activeOptions} />
        <GameHud
          snapshot={snapshot}
          heroClass={activeOptions.heroClass}
          onExit={returnToBriefing}
        />
        <UpgradeDraft
          choices={upgradeChoices}
          onChoose={chooseUpgrade}
        />
        <ResultOverlay
          result={result}
          heroClass={activeOptions.heroClass}
          onRetry={retryRun}
          onLobby={returnToBriefing}
        />
      </main>
    );
  }

  return (
    <main className="briefing-shell">
      <div className="page-noise" aria-hidden="true" />
      <header className="site-header">
        <a className="brand" href="#top" aria-label="5일 뒤 마왕 홈">
          <span className="brand-mark" aria-hidden="true">V</span>
          <span>
            <strong>5일 뒤 마왕</strong>
            <small>FIVE DAYS TO THE DEMON KING</small>
          </span>
        </a>
        <div className="header-status">
          <span className="status-dot" aria-hidden="true" />
          <span>프로토타입 서버</span>
          <span className="header-divider" />
          <span>{headerIdentity}</span>
        </div>
      </header>

      <section className="hero-section" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span>왕국 긴급 의뢰</span><span>DAY − 5</span></div>
          <h1>
            낮에는 욕심내고,<br />
            <em>밤에는 살아남아라.</em>
          </h1>
          <p className="hero-lead">
            오늘 막 뽑힌 용사 파티에게 남은 시간은 단 5일.
            필드를 개척해 사기 빌드를 완성하고, 무너지는 기지 너머의 마왕을 쓰러뜨리세요.
          </p>
          <div className="hero-meta" aria-label="게임 핵심 정보">
            <span><b>01</b> 자동 평타 + 수동 스킬</span>
            <span><b>02</b> 공유 성장과 기지 건설</span>
            <span><b>03</b> 5일차 마왕 레이드</span>
          </div>
        </div>
        <div className="hero-visual" aria-label={`${selectedDefinition.name} 선택 미리보기`}>
          <div className={`hero-sigil hero-sigil--${selectedClass}`}>
            <span>{selectedDefinition.name.slice(0, 1)}</span>
          </div>
          <div className="orbit orbit--one" aria-hidden="true" />
          <div className="orbit orbit--two" aria-hidden="true" />
          <div className="hero-card-floating">
            <span>SELECTED HERO</span>
            <strong>{selectedDefinition.name}</strong>
            <small>{selectedDefinition.epithet}</small>
          </div>
          <div className="threat-card">
            <small>마왕 도착까지</small>
            <strong>05</strong>
            <span>DAYS</span>
          </div>
        </div>
      </section>

      <section className="loadout-section" aria-labelledby="loadout-title">
        <div className="section-heading">
          <div>
            <span className="section-index">01 / PARTY SETUP</span>
            <h2 id="loadout-title">신참 용사를 선택하세요</h2>
          </div>
          <p>세 클래스의 공격 거리와 성장 분기가 완전히 다릅니다. 나머지 두 클래스는 AI 동료로 합류합니다.</p>
        </div>

        <div className="class-grid" role="radiogroup" aria-label="클래스 선택">
          {CLASS_ORDER.map((classId, index) => {
            const definition = CLASS_DEFINITIONS[classId];
            const selected = selectedClass === classId;
            return (
              <button
                className={`class-card ${selected ? "is-selected" : ""}`}
                key={classId}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setSelectedClass(classId)}
                style={{ "--class-color": definition.cssColor } as React.CSSProperties}
              >
                <span className="class-number">0{index + 1}</span>
                <span className={`mini-sigil mini-sigil--${classId}`}>{definition.name.slice(0, 1)}</span>
                <span className="class-title"><strong>{definition.name}</strong><small>{definition.role}</small></span>
                <span className="class-description">{definition.description}</span>
                <span className="class-skills">
                  <i>Q</i>{definition.skills[0].name}
                  <i>E</i>{definition.skills[1].name}
                </span>
                <span className="class-select-label">{selected ? "선택 완료" : "이 용사 선택"}</span>
              </button>
            );
          })}
        </div>

        <div className="launch-panel">
          <div className="launch-options">
            <fieldset>
              <legend>세션 길이</legend>
              <div className="segmented-control">
                <button type="button" className={sessionMode === "prototype" ? "active" : ""} onClick={() => setSessionMode("prototype")}>
                  프로토타입 <small>약 8분</small>
                </button>
                <button type="button" className={sessionMode === "full" ? "active" : ""} onClick={() => setSessionMode("full")}>
                  정식 흐름 <small>25분</small>
                </button>
              </div>
            </fieldset>
            <fieldset>
              <legend>난이도</legend>
              <div className="segmented-control segmented-control--difficulty">
                {(["easy", "normal", "hard"] as const).map((value) => (
                  <button key={value} type="button" className={difficulty === value ? "active" : ""} onClick={() => setDifficulty(value)}>
                    {value === "easy" ? "이지" : value === "normal" ? "노말" : "하드"}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
          <div className="launch-summary">
            <span>출전 클래스</span><strong>{selectedDefinition.name}</strong>
            <span>예상 작전</span><strong>{modeLabel}</strong>
          </div>
          <button className="primary-launch" type="button" onClick={() => void beginRun()} disabled={networkStatus === "connecting"}>
            <span>원정 시작</span>
            <small>WASD · Q/E · SPACE</small>
          </button>
          {networkError ? <p role="alert">{networkError}</p> : null}
        </div>
      </section>

      <section className="mission-section" aria-labelledby="mission-title">
        <div className="mission-intro">
          <span className="section-index">02 / FIVE DAY OPERATION</span>
          <h2 id="mission-title">5일 동안 강해지고,<br />한 번의 레이드로 증명합니다.</h2>
        </div>
        <ol className="day-track">
          {[
            ["DAY 01", "들판 개척", "첫 특성과 포탑"],
            ["DAY 02", "오염 숲", "전직 분기와 장비"],
            ["DAY 03", "마왕성 외곽", "히든 엘리트"],
            ["DAY 04", "최종 정비", "조기 도전 가능"],
            ["DAY 05", "마왕 레이드", "시간 내 처치"],
          ].map(([day, title, note], index) => (
            <li key={day} className={index === 4 ? "is-final" : ""}>
              <span>{day}</span><strong>{title}</strong><small>{note}</small>
            </li>
          ))}
        </ol>
      </section>

      <Guestbook viewer={viewer} />

      <footer className="site-footer">
        <span>《5일 뒤 마왕》 vertical slice prototype</span>
        <span>Phaser 3 · Next.js · Colyseus · PostgreSQL</span>
      </footer>
    </main>
  );
}
