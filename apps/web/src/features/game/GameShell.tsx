"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { HeroClassId, LobbyChatMessage, LobbyGameStart, LobbyListing } from "@five-days/protocol";
import { GameCanvas } from "@/src/game/client/GameCanvas";
import {
  EMPTY_SNAPSHOT,
  type GameResult,
  type GameSnapshot,
  type GameStartOptions,
  type UpgradeChoice,
} from "@/src/game/domain/types";
import { resolveRuntimeOptions } from "@/src/game/domain/runtimeOptions";
import { gameBridge } from "@/src/game/runtime/GameBridge";
import { colyseusTransport, type NetworkStatus } from "@/src/game/transport/ColyseusTransport";
import { globalChatTransport } from "@/src/game/transport/GlobalChatTransport";
import { lobbyTransport, type LobbySnapshot } from "@/src/game/transport/LobbyTransport";
import { AccessScreen } from "../lobby/AccessScreen";
import { CharacterSelectScreen } from "../lobby/CharacterSelectScreen";
import { LobbyScreen } from "../lobby/LobbyScreen";
import { MapEditorScreen } from "../map-editor/MapEditorScreen";
import { AugmentLabScreen } from "../lab/AugmentLabScreen";
import type { EditorMapDefinition } from "@/src/game/domain/mapEditor";
import { GameHud } from "./GameHud";
import { ResultOverlay } from "./ResultOverlay";

export type Viewer = {
  userId: string;
  displayName: string;
  accountType: "member" | "guest";
  csrfToken: string;
} | null;

type Screen = "access" | "lobby" | "selecting" | "editor" | "lab" | "playing";
const RUN_RECOVERY_KEY = "five-days:active-run:v1";
const RUN_RECOVERY_TTL_MS = 35 * 60 * 1000;

export function GameShell({ viewer: initialViewer, gameServerUrl, publicPlaytestEnabled, localMapEditorEnabled, autoStartOptions, sessionUnavailable = false, initialScreen = null }: {
  viewer: Viewer;
  gameServerUrl: string;
  publicPlaytestEnabled: boolean;
  localMapEditorEnabled: boolean;
  autoStartOptions: GameStartOptions | null;
  sessionUnavailable?: boolean;
  initialScreen?: Screen | null;
}) {
  const router = useRouter();
  const autoStartAttempted = useRef(false);
  const recoveryAttempted = useRef(false);
  const snapshotRef = useRef<GameSnapshot>(EMPTY_SNAPSHOT);
  const runGenerationRef = useRef(0);
  const [viewer, setViewer] = useState<Viewer>(initialViewer);
  const [authUnavailable, setAuthUnavailable] = useState(sessionUnavailable);
  const [screen, setScreen] = useState<Screen>(initialScreen ?? "access");
  const [activeOptions, setActiveOptions] = useState<GameStartOptions | null>(null);
  const [runKey, setRunKey] = useState(0);
  const [snapshot, setSnapshot] = useState<GameSnapshot>(EMPTY_SNAPSHOT);
  const [upgradeChoices, setUpgradeChoices] = useState<UpgradeChoice[]>([]);
  const [result, setResult] = useState<GameResult | null>(null);
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus>("idle");
  const [rooms, setRooms] = useState<LobbyListing[]>([]);
  const [lobby, setLobby] = useState<LobbySnapshot | null>(null);
  const [messages, setMessages] = useState<LobbyChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [surfaceError, setSurfaceError] = useState(sessionUnavailable ? "세션 저장소에 일시적으로 연결할 수 없습니다. 잠시 후 다시 시도해 주세요." : "");
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    if (!authUnavailable) return;
    let active = true;
    const retry = async () => {
      try {
        const response = await fetch("/api/session", { cache: "no-store" });
        if (!response.ok) return;
        const value = await response.json() as { viewer?: Omit<NonNullable<Viewer>, "csrfToken"> | null; csrfToken?: string | null };
        if (!active) return;
        if (value.viewer && value.csrfToken) setViewer({ ...value.viewer, csrfToken: value.csrfToken });
        setAuthUnavailable(false);
        setSurfaceError("");
      } catch {
        // Keep the last known authentication state and retry without logging out.
      }
    };
    void retry();
    const timer = window.setInterval(retry, 3_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [authUnavailable]);

  useEffect(() => {
    const offSnapshot = gameBridge.on("snapshot", (nextSnapshot) => {
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
    });
    const offUpgrade = gameBridge.on("upgrade", setUpgradeChoices);
    const offResult = gameBridge.on("result", setResult);
    const offNetwork = colyseusTransport.subscribe((state) => {
      setNetworkStatus(state.phase === "lobby" ? "waiting" : "connected");
      if (state.phase === "ended") {
        const finalSnapshot = snapshotRef.current;
        setResult({
          state: state.resultState === "victory" ? "victory" : "defeat",
          reason: state.resultReason || "원정이 종료되었습니다.",
          elapsed: state.elapsed || finalSnapshot.elapsed,
          day: state.day,
          level: state.teamLevel,
          teamPower: state.players.reduce((total, player) => total + player.teamPower, 0),
          stats: { ...state.stats },
        });
      }
    });
    const offNetworkEvent = colyseusTransport.subscribeEvents((event) => {
      if (event.type === "reconnecting") setNetworkStatus("reconnecting");
      if (event.type === "reconnected") setNetworkStatus("connected");
      if (event.type === "disconnected") setNetworkStatus("disconnected");
      if (event.type === "result") {
        clearRunRecovery();
        const current = snapshotRef.current;
        setResult({
          state: event.state === "victory" ? "victory" : "defeat",
          reason: event.message ?? "원정이 종료되었습니다.",
          elapsed: current.elapsed,
          day: current.day,
          level: current.level,
          teamPower: current.teamPower,
          stats: { ...current.stats },
        });
      }
    });
    return () => {
      runGenerationRef.current += 1;
      offSnapshot(); offUpgrade(); offResult(); offNetwork(); offNetworkEvent();
      colyseusTransport.disconnect();
    };
  }, []);

  const beginRun = useCallback(async (options: GameStartOptions, roomId?: string) => {
    const runGeneration = ++runGenerationRef.current;
    if (gameServerUrl && !viewer) {
      setSurfaceError("게임 서버에 접속하려면 먼저 로그인해 주세요.");
      return;
    }
    setNetworkStatus("connecting");
    setSurfaceError("");
    try {
      if (gameServerUrl) {
        await colyseusTransport.connect({ serverUrl: gameServerUrl, csrfToken: viewer!.csrfToken, options, roomId, userId: viewer!.userId });
        const activeRoomId = colyseusTransport.activeRoomId;
        if (activeRoomId) saveRunRecovery(viewer!.userId, activeRoomId, options);
      }
      if (runGeneration !== runGenerationRef.current) return;
      setNetworkStatus("connected");
      setSnapshot(EMPTY_SNAPSHOT);
      setUpgradeChoices([]);
      setResult(null);
      setActiveOptions(resolveRuntimeOptions(options, gameServerUrl));
      setRunKey((value) => value + 1);
      setScreen("playing");
    } catch (error) {
      if (runGeneration !== runGenerationRef.current) return;
      setNetworkStatus("error");
      setLaunching(false);
      setSurfaceError(formatClientError(error, "게임 서버에 연결하지 못했습니다."));
      if (roomId) clearRunRecovery();
    }
  }, [gameServerUrl, viewer]);

  useEffect(() => {
    if (!viewer || !gameServerUrl || recoveryAttempted.current || autoStartOptions) return;
    recoveryAttempted.current = true;
    const recovery = readRunRecovery(viewer.userId);
    if (!recovery) return;
    const timeoutId = window.setTimeout(() => void beginRun(recovery.options, recovery.roomId), 0);
    return () => window.clearTimeout(timeoutId);
  }, [autoStartOptions, beginRun, gameServerUrl, viewer]);

  useEffect(() => {
    const offSnapshot = lobbyTransport.on("snapshot", (value) => {
      setLobby(value);
      if (value.phase === "selecting") setScreen((current) => current === "playing" ? current : "selecting");
      if (value.phase === "waiting") setScreen((current) => current === "selecting" ? "lobby" : current);
    });
    const offError = lobbyTransport.on("error", (error) => setSurfaceError(formatClientError(error, "로비 요청을 처리하지 못했습니다.")));
    const offDisconnected = lobbyTransport.on("disconnected", ({ reason }) => {
      setLobby(null);
      setSurfaceError(formatClientError(reason, "대기실 연결이 종료되었습니다."));
      setScreen((current) => current === "playing" ? current : "lobby");
    });
    const offStart = lobbyTransport.on("start", (event: LobbyGameStart) => {
      if (!viewer) return;
      const heroClass = event.playerClasses[viewer.userId] as HeroClassId | undefined;
      if (!heroClass) return setSurfaceError("확정된 캐릭터 정보를 찾지 못했습니다.");
      setLaunching(true);
      window.setTimeout(() => void beginRun({ heroClass, sessionMode: event.sessionMode, difficulty: event.difficulty, partyMode: "coop" }, event.gameRoomId), 1100);
    });
    return () => { offSnapshot(); offError(); offDisconnected(); offStart(); void lobbyTransport.leave(); };
  }, [beginRun, viewer]);

  useEffect(() => {
    if (screen !== "lobby" || !viewer || !gameServerUrl) return;
    const offChat = globalChatTransport.on("chat", (message) => setMessages((current) => [...current, message].slice(-100)));
    const offHistory = globalChatTransport.on("history", (history) => setMessages(history.slice(-100)));
    const offError = globalChatTransport.on("error", (error) => setSurfaceError(formatClientError(error, "전체 채팅 요청을 처리하지 못했습니다.")));
    const offDisconnected = globalChatTransport.on("disconnected", ({ reason }) => {
      setSurfaceError(formatClientError(reason, "전체 채팅 연결이 종료되었습니다."));
    });
    void globalChatTransport.connect({ serverUrl: gameServerUrl, csrfToken: viewer.csrfToken }).catch((error) => {
      setSurfaceError(formatClientError(error, "전체 채팅에 연결하지 못했습니다."));
    });
    return () => {
      offChat(); offHistory(); offError(); offDisconnected();
      void globalChatTransport.leave();
    };
  }, [gameServerUrl, screen, viewer]);

  useEffect(() => {
    if (screen !== "lobby") return;
    let active = true;
    const refresh = async () => {
      try {
        const listings = await lobbyTransport.list(gameServerUrl);
        if (active) setRooms(listings);
      } catch (error) {
        if (active) setSurfaceError(formatClientError(error, "방 목록을 불러오지 못했습니다."));
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [gameServerUrl, screen]);

  useEffect(() => {
    if (!viewer || !autoStartOptions || autoStartAttempted.current) return;
    autoStartAttempted.current = true;
    void beginRun(autoStartOptions);
  }, [autoStartOptions, beginRun, viewer]);

  const createLobby = useCallback(async (options: { roomName: string; sessionMode: "prototype" | "full"; difficulty: "easy" | "normal" | "hard" }) => {
    if (!viewer) return;
    setBusy(true); setSurfaceError("");
    try { await lobbyTransport.create({ serverUrl: gameServerUrl, csrfToken: viewer.csrfToken, options }); }
    catch (error) { setSurfaceError(formatClientError(error, "방을 만들지 못했습니다.")); }
    finally { setBusy(false); }
  }, [gameServerUrl, viewer]);

  const joinLobby = useCallback(async (roomId: string) => {
    if (!viewer) return;
    setBusy(true); setSurfaceError("");
    try { await lobbyTransport.join({ serverUrl: gameServerUrl, csrfToken: viewer.csrfToken, roomId }); }
    catch (error) { setSurfaceError(formatClientError(error, "방에 참가하지 못했습니다.")); }
    finally { setBusy(false); }
  }, [gameServerUrl, viewer]);

  const startSoloExpedition = useCallback(async () => {
    if (!viewer) return;
    setBusy(true); setSurfaceError("");
    try {
      await lobbyTransport.createSoloExpedition({
        serverUrl: gameServerUrl,
        csrfToken: viewer.csrfToken,
        userId: viewer.userId,
        options: { roomName: viewer.displayName, sessionMode: "prototype", difficulty: "normal" },
      });
    } catch (error) {
      setSurfaceError(formatClientError(error, "혼자 원정을 준비하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }, [gameServerUrl, viewer]);

  const leaveLobby = useCallback(async () => {
    setBusy(true);
    await lobbyTransport.leave();
    setLobby(null); setBusy(false);
  }, []);

  const guestLogin = useCallback(async (displayName: string) => {
    if (!publicPlaytestEnabled) {
      setSurfaceError("현재 공개 게스트 테스트가 비활성화되어 있습니다.");
      return;
    }
    setBusy(true); setSurfaceError("");
    try {
      const response = await fetch("/api/auth/guest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName }) });
      const text = await response.text();
      const value = text ? (JSON.parse(text) as { viewer?: NonNullable<Viewer>; csrfToken?: string; error?: { message: string } }) : {};
      if (!response.ok || !value.viewer || !value.csrfToken) throw new Error(value.error?.message ?? "게스트 세션을 만들지 못했습니다.");
      setViewer({ ...value.viewer, csrfToken: value.csrfToken });
    } catch (error) {
      setSurfaceError(formatClientError(error, "게스트 세션을 만들지 못했습니다."));
    }
    finally { setBusy(false); }
  }, [publicPlaytestEnabled]);

  const logout = useCallback(async () => {
    if (!viewer) return;
    setBusy(true); setSurfaceError("");
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "x-csrf-token": viewer.csrfToken },
      });
      if (!response.ok) throw new Error("로그아웃 요청을 처리하지 못했습니다.");
      clearRunRecovery();
      setViewer(null);
      router.refresh();
    } catch (error) {
      setSurfaceError(formatClientError(error, "로그아웃 요청을 처리하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }, [router, viewer]);

  const returnToLobby = useCallback(() => {
    const wasEditorPlaytest = Boolean(activeOptions?.editorMap);
    runGenerationRef.current += 1;
    clearRunRecovery();
    colyseusTransport.disconnect();
    lobbyTransport.returnFromGame();
    setNetworkStatus("disconnected"); setResult(null); setUpgradeChoices([]); snapshotRef.current = EMPTY_SNAPSHOT; setSnapshot(EMPTY_SNAPSHOT); setActiveOptions(null); setLaunching(false);
    setScreen(wasEditorPlaytest ? "editor" : lobby ? "lobby" : "access");
  }, [activeOptions?.editorMap, lobby]);

  const chooseUpgrade = useCallback((upgradeId: UpgradeChoice["id"]) => {
    gameBridge.command({ type: "choose-upgrade", upgradeId });
    if (!activeOptions?.networked) setUpgradeChoices([]);
  }, [activeOptions?.networked]);

  const playEditorMap = useCallback((editorMap: EditorMapDefinition) => {
    if (!localMapEditorEnabled) return;
    runGenerationRef.current += 1;
    colyseusTransport.disconnect();
    setNetworkStatus("connected");
    setSnapshot(EMPTY_SNAPSHOT);
    setUpgradeChoices([]);
    setResult(null);
    setActiveOptions({ heroClass: "swordsman", sessionMode: "prototype", difficulty: "normal", partyMode: "solo", networked: false, userId: viewer?.userId ?? "map-editor", editorMap });
    setRunKey((value) => value + 1);
    setScreen("playing");
  }, [localMapEditorEnabled, viewer?.userId]);

  if (screen === "playing" && activeOptions) return <main className="play-screen">
    <div className="network-status" role="status">{activeOptions.editorMap ? "로컬 맵 테스트" : `게임 서버 · ${networkStatus === "connected" ? "연결됨" : networkStatus}`}</div>
    <GameCanvas key={runKey} options={activeOptions} />
    <GameHud snapshot={snapshot} heroClass={activeOptions.heroClass} onExit={returnToLobby} upgradeChoices={upgradeChoices} onChoose={chooseUpgrade} />
    <ResultOverlay result={result} heroClass={activeOptions.heroClass} onLobby={returnToLobby} />
  </main>;

  if (screen === "selecting" && lobby && viewer) return <CharacterSelectScreen snapshot={lobby} viewerId={viewer.userId} launching={launching} onSelect={(heroClass) => lobbyTransport.selectClass(heroClass)} />;

  if (screen === "lobby" && viewer) return <LobbyScreen viewer={viewer} rooms={rooms} snapshot={lobby} messages={messages} busy={busy} error={surfaceError} onCreate={createLobby} onJoin={joinLobby} onLeave={leaveLobby} onReady={(ready) => lobbyTransport.ready(ready)} onStart={() => lobbyTransport.startSelection()} onSoloStart={startSoloExpedition} onChat={(message) => globalChatTransport.chat(message)} onAddAi={() => lobbyTransport.addAi()} onRemoveAi={(userId) => lobbyTransport.removeAi(userId)} onBack={() => setScreen("access")} />;

  if (screen === "lab") return <AugmentLabScreen onBack={() => setScreen("access")} />;
  if (screen === "editor" && localMapEditorEnabled) return <MapEditorScreen onBack={() => setScreen("access")} onPlay={playEditorMap} />;

  const quickPlayMage = () => void beginRun({ heroClass: "mage", sessionMode: "prototype", difficulty: "normal", partyMode: "solo" });
  return <AccessScreen viewer={viewer} busy={busy} error={surfaceError} onGuest={guestLogin} onLogout={logout} editorEnabled={localMapEditorEnabled} onOpenEditor={() => { if (localMapEditorEnabled) setScreen("editor"); }} onOpenLab={() => setScreen("lab")} onStart={() => { setSurfaceError(""); if (gameServerUrl) setScreen("lobby"); else void beginRun({ heroClass: "swordsman", sessionMode: "prototype", difficulty: "normal", partyMode: "solo" }); }} onQuickPlayMage={quickPlayMage} />;
}

function saveRunRecovery(userId: string, roomId: string, options: GameStartOptions): void {
  if (typeof window === "undefined" || options.editorMap) return;
  const safeOptions = {
    heroClass: options.heroClass,
    sessionMode: options.sessionMode,
    difficulty: options.difficulty,
    partyMode: options.partyMode,
  } satisfies GameStartOptions;
  sessionStorage.setItem(RUN_RECOVERY_KEY, JSON.stringify({ userId, roomId, options: safeOptions, expiresAt: Date.now() + RUN_RECOVERY_TTL_MS }));
}

function readRunRecovery(userId: string): { roomId: string; options: GameStartOptions } | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(RUN_RECOVERY_KEY) ?? "null") as Record<string, unknown> | null;
    const options = value?.options as Record<string, unknown> | undefined;
    if (!value || value.userId !== userId || typeof value.roomId !== "string" || typeof value.expiresAt !== "number" || value.expiresAt <= Date.now()
      || !options || !["swordsman", "archer", "mage"].includes(String(options.heroClass))
      || !["prototype", "full"].includes(String(options.sessionMode)) || !["easy", "normal", "hard"].includes(String(options.difficulty))
      || !["solo", "coop"].includes(String(options.partyMode))) {
      clearRunRecovery();
      return null;
    }
    return { roomId: value.roomId, options: options as GameStartOptions };
  } catch {
    clearRunRecovery();
    return null;
  }
}

function clearRunRecovery(): void {
  if (typeof window !== "undefined") sessionStorage.removeItem(RUN_RECOVERY_KEY);
}

function formatClientError(error: unknown, fallback: string): string {
  if (typeof error === "string") return error.includes("[object Object]") ? fallback : error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    const code = (error as { code?: unknown }).code;
    if (typeof message === "string" && !message.includes("[object Object]")) return message;
    if (typeof code === "string" || typeof code === "number") return `${fallback} (코드: ${code})`;
    if (message && typeof message === "object") {
      const nested = message as { message?: unknown; code?: unknown };
      if (typeof nested.message === "string" && !nested.message.includes("[object Object]")) return nested.message;
      if (typeof nested.code === "string") return nested.code;
      try { return JSON.stringify(message); } catch { /* use fallback */ }
    }
  }
  return fallback;
}
