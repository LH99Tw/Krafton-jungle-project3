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
import { gameBridge } from "@/src/game/runtime/GameBridge";
import { colyseusTransport, type NetworkStatus } from "@/src/game/transport/ColyseusTransport";
import { lobbyTransport, type LobbySnapshot } from "@/src/game/transport/LobbyTransport";
import { AccessScreen } from "../lobby/AccessScreen";
import { CharacterSelectScreen } from "../lobby/CharacterSelectScreen";
import { LobbyScreen } from "../lobby/LobbyScreen";
import { GameHud } from "./GameHud";
import { ResultOverlay } from "./ResultOverlay";
import { UpgradeDraft } from "./UpgradeDraft";

export type Viewer = {
  userId: string;
  displayName: string;
  email: string;
  accountType: "member" | "guest";
  csrfToken: string;
} | null;

type Screen = "access" | "lobby" | "selecting" | "playing";

export function GameShell({ viewer: initialViewer, gameServerUrl, publicPlaytestEnabled, autoStartOptions }: {
  viewer: Viewer;
  gameServerUrl: string;
  publicPlaytestEnabled: boolean;
  autoStartOptions: GameStartOptions | null;
}) {
  const router = useRouter();
  const autoStartAttempted = useRef(false);
  const snapshotRef = useRef<GameSnapshot>(EMPTY_SNAPSHOT);
  const runGenerationRef = useRef(0);
  const [viewer, setViewer] = useState<Viewer>(initialViewer);
  const [screen, setScreen] = useState<Screen>("access");
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
  const [surfaceError, setSurfaceError] = useState("");
  const [launching, setLaunching] = useState(false);

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
    const currentViewer = viewer ?? { userId: "local-guest", displayName: "로컬 용사", email: "guest@local", accountType: "guest" as const, csrfToken: "dev-csrf" };
    setNetworkStatus("connecting");
    setSurfaceError("");
    try {
      if (gameServerUrl) {
        await colyseusTransport.connect({ serverUrl: gameServerUrl, csrfToken: currentViewer.csrfToken, options, roomId, userId: currentViewer.userId });
      }
      if (runGeneration !== runGenerationRef.current) return;
      setNetworkStatus("connected");
      setSnapshot(EMPTY_SNAPSHOT);
      setUpgradeChoices([]);
      setResult(null);
      setActiveOptions(options);
      setRunKey((value) => value + 1);
      setScreen("playing");
    } catch {
      if (runGeneration !== runGenerationRef.current) return;
      setNetworkStatus("connected");
      setSnapshot(EMPTY_SNAPSHOT);
      setUpgradeChoices([]);
      setResult(null);
      setActiveOptions(options);
      setRunKey((value) => value + 1);
      setScreen("playing");
    }
  }, [gameServerUrl, viewer]);

  useEffect(() => {
    const offSnapshot = lobbyTransport.on("snapshot", (value) => {
      setLobby(value);
      if (value.phase === "selecting") setScreen((current) => current === "playing" ? current : "selecting");
      if (value.phase === "waiting") setScreen((current) => current === "selecting" ? "lobby" : current);
    });
    const offChat = lobbyTransport.on("chat", (message) => setMessages((current) => [...current, message].slice(-50)));
    const offHistory = lobbyTransport.on("history", setMessages);
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
    return () => { offSnapshot(); offChat(); offHistory(); offError(); offDisconnected(); offStart(); void lobbyTransport.leave(); };
  }, [beginRun, viewer]);

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
    setBusy(true); setSurfaceError(""); setMessages([]);
    try { await lobbyTransport.create({ serverUrl: gameServerUrl, csrfToken: viewer.csrfToken, options }); }
    catch (error) { setSurfaceError(formatClientError(error, "방을 만들지 못했습니다.")); }
    finally { setBusy(false); }
  }, [gameServerUrl, viewer]);

  const joinLobby = useCallback(async (roomId: string) => {
    if (!viewer) return;
    setBusy(true); setSurfaceError(""); setMessages([]);
    try { await lobbyTransport.join({ serverUrl: gameServerUrl, csrfToken: viewer.csrfToken, roomId }); }
    catch (error) { setSurfaceError(formatClientError(error, "방에 참가하지 못했습니다.")); }
    finally { setBusy(false); }
  }, [gameServerUrl, viewer]);

  const leaveLobby = useCallback(async () => {
    setBusy(true);
    await lobbyTransport.leave();
    setLobby(null); setMessages([]); setBusy(false);
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
      if (!response.ok || !value.viewer || !value.csrfToken) {
        setViewer({ userId: "local-guest", displayName: displayName.trim() || "로컬 용사", email: "guest@local", accountType: "guest", csrfToken: "dev-csrf" });
        return;
      }
      setViewer({ ...value.viewer, csrfToken: value.csrfToken });
    } catch {
      setViewer({ userId: "local-guest", displayName: displayName.trim() || "로컬 용사", email: "guest@local", accountType: "guest", csrfToken: "dev-csrf" });
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
      await response.text();
      setViewer(null);
      router.refresh();
    } catch {
      setViewer(null);
    } finally {
      setBusy(false);
    }
  }, [router, viewer]);

  const returnToLobby = useCallback(() => {
    runGenerationRef.current += 1;
    colyseusTransport.disconnect();
    lobbyTransport.returnFromGame();
    setNetworkStatus("disconnected"); setResult(null); setUpgradeChoices([]); snapshotRef.current = EMPTY_SNAPSHOT; setSnapshot(EMPTY_SNAPSHOT); setActiveOptions(null); setLaunching(false);
    setScreen(lobby ? "lobby" : "access");
  }, [lobby]);

  const chooseUpgrade = useCallback((upgradeId: UpgradeChoice["id"]) => {
    gameBridge.command({ type: "choose-upgrade", upgradeId });
    if (!activeOptions?.networked) setUpgradeChoices([]);
  }, [activeOptions?.networked]);

  if (screen === "playing" && activeOptions) return <main className="play-screen">
    <div className="network-status" role="status">게임 서버 · {networkStatus === "connected" ? "연결됨" : networkStatus}</div>
    <GameCanvas key={runKey} options={activeOptions} />
    <GameHud snapshot={snapshot} heroClass={activeOptions.heroClass} onExit={returnToLobby} upgradeChoices={upgradeChoices} onChoose={chooseUpgrade} />
    <ResultOverlay result={result} heroClass={activeOptions.heroClass} onLobby={returnToLobby} />
  </main>;

  if (screen === "selecting" && lobby && viewer) return <CharacterSelectScreen snapshot={lobby} viewerId={viewer.userId} launching={launching} onSelect={(heroClass) => lobbyTransport.selectClass(heroClass)} />;

  if (screen === "lobby" && viewer) return <LobbyScreen viewer={viewer} rooms={rooms} snapshot={lobby} messages={messages} busy={busy} error={surfaceError} onCreate={createLobby} onJoin={joinLobby} onLeave={leaveLobby} onReady={(ready) => lobbyTransport.ready(ready)} onStart={() => lobbyTransport.startSelection()} onOfflineStart={() => void beginRun({ heroClass: "swordsman", sessionMode: "prototype", difficulty: "normal", partyMode: "solo" })} onChat={(message) => lobbyTransport.chat(message)} onAddAi={() => lobbyTransport.addAi()} onRemoveAi={(userId) => lobbyTransport.removeAi(userId)} onBack={() => setScreen("access")} />;

  return <AccessScreen viewer={viewer} busy={busy} error={surfaceError} onGuest={guestLogin} onLogout={logout} onStart={() => { setSurfaceError(""); if (gameServerUrl) setScreen("lobby"); else void beginRun({ heroClass: "swordsman", sessionMode: "prototype", difficulty: "normal", partyMode: "solo" }); }} />;
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
