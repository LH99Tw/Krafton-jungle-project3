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

export function GameShell({ viewer: initialViewer, gameServerUrl, autoStartOptions }: {
  viewer: Viewer;
  gameServerUrl: string;
  autoStartOptions: GameStartOptions | null;
}) {
  const router = useRouter();
  const autoStartAttempted = useRef(false);
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
    const offSnapshot = gameBridge.on("snapshot", setSnapshot);
    const offUpgrade = gameBridge.on("upgrade", setUpgradeChoices);
    const offResult = gameBridge.on("result", setResult);
    return () => { offSnapshot(); offUpgrade(); offResult(); colyseusTransport.disconnect(); };
  }, []);

  const beginRun = useCallback(async (options: GameStartOptions, roomId?: string) => {
    if (!viewer) {
      router.push("/api/auth/login?returnTo=/");
      return;
    }
    setNetworkStatus("connecting");
    setSurfaceError("");
    try {
      await colyseusTransport.connect({ serverUrl: gameServerUrl, csrfToken: viewer.csrfToken, options, roomId });
      setNetworkStatus("connected");
      setSnapshot(EMPTY_SNAPSHOT);
      setUpgradeChoices([]);
      setResult(null);
      setActiveOptions(options);
      setRunKey((value) => value + 1);
      setScreen("playing");
    } catch (error) {
      setNetworkStatus("error");
      setLaunching(false);
      setSurfaceError(error instanceof Error ? error.message : "게임 서버에 연결하지 못했습니다.");
      setScreen("selecting");
    }
  }, [gameServerUrl, router, viewer]);

  useEffect(() => {
    const offSnapshot = lobbyTransport.on("snapshot", (value) => {
      setLobby(value);
      if (value.phase === "selecting") setScreen((current) => current === "playing" ? current : "selecting");
      if (value.phase === "waiting") setScreen((current) => current === "selecting" ? "lobby" : current);
    });
    const offChat = lobbyTransport.on("chat", (message) => setMessages((current) => [...current, message].slice(-50)));
    const offHistory = lobbyTransport.on("history", setMessages);
    const offError = lobbyTransport.on("error", (error) => setSurfaceError(error.message));
    const offDisconnected = lobbyTransport.on("disconnected", ({ reason }) => {
      setLobby(null);
      setSurfaceError(reason);
      setScreen((current) => current === "playing" ? current : "lobby");
    });
    const offStart = lobbyTransport.on("start", (event: LobbyGameStart) => {
      if (!viewer) return;
      const heroClass = event.playerClasses[viewer.userId] as HeroClassId | undefined;
      if (!heroClass) return setSurfaceError("확정된 캐릭터 정보를 찾지 못했습니다.");
      setLaunching(true);
      window.setTimeout(() => void beginRun({ heroClass, sessionMode: event.sessionMode, difficulty: event.difficulty }, event.gameRoomId), 1100);
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
        if (active) setSurfaceError(error instanceof Error ? error.message : "방 목록을 불러오지 못했습니다.");
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
    catch (error) { setSurfaceError(error instanceof Error ? error.message : "방을 만들지 못했습니다."); }
    finally { setBusy(false); }
  }, [gameServerUrl, viewer]);

  const joinLobby = useCallback(async (roomId: string) => {
    if (!viewer) return;
    setBusy(true); setSurfaceError(""); setMessages([]);
    try { await lobbyTransport.join({ serverUrl: gameServerUrl, csrfToken: viewer.csrfToken, roomId }); }
    catch (error) { setSurfaceError(error instanceof Error ? error.message : "방에 참가하지 못했습니다."); }
    finally { setBusy(false); }
  }, [gameServerUrl, viewer]);

  const leaveLobby = useCallback(async () => {
    setBusy(true);
    await lobbyTransport.leave();
    setLobby(null); setMessages([]); setBusy(false);
  }, []);

  const guestLogin = useCallback(async (displayName: string) => {
    setBusy(true); setSurfaceError("");
    try {
      const response = await fetch("/api/auth/guest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName }) });
      const value = await response.json() as { viewer?: NonNullable<Viewer>; csrfToken?: string; error?: { message: string } };
      if (!response.ok || !value.viewer || !value.csrfToken) throw new Error(value.error?.message ?? "게스트 접속에 실패했습니다.");
      setViewer({ ...value.viewer, csrfToken: value.csrfToken });
    } catch (error) { setSurfaceError(error instanceof Error ? error.message : "게스트 접속에 실패했습니다."); }
    finally { setBusy(false); }
  }, []);

  const returnToLobby = useCallback(() => {
    colyseusTransport.disconnect();
    lobbyTransport.returnFromGame();
    setNetworkStatus("disconnected"); setResult(null); setUpgradeChoices([]); setSnapshot(EMPTY_SNAPSHOT); setActiveOptions(null); setLaunching(false);
    setScreen(lobby ? "lobby" : "access");
  }, [lobby]);

  const chooseUpgrade = useCallback((upgradeId: UpgradeChoice["id"]) => {
    gameBridge.command({ type: "choose-upgrade", upgradeId });
    setUpgradeChoices([]);
  }, []);

  if (screen === "playing" && activeOptions) return <main className="play-screen">
    <div className="network-status" role="status">게임 서버 · {networkStatus === "connected" ? "연결됨" : networkStatus}</div>
    <GameCanvas key={runKey} options={activeOptions} />
    <GameHud snapshot={snapshot} heroClass={activeOptions.heroClass} onExit={returnToLobby} />
    <UpgradeDraft choices={upgradeChoices} onChoose={chooseUpgrade} />
    <ResultOverlay result={result} heroClass={activeOptions.heroClass} onLobby={returnToLobby} />
  </main>;

  if (screen === "selecting" && lobby && viewer) return <CharacterSelectScreen snapshot={lobby} viewerId={viewer.userId} launching={launching} onSelect={(heroClass) => lobbyTransport.selectClass(heroClass)} />;

  if (screen === "lobby" && viewer) return <LobbyScreen viewer={viewer} rooms={rooms} snapshot={lobby} messages={messages} busy={busy} error={surfaceError} onCreate={createLobby} onJoin={joinLobby} onLeave={leaveLobby} onReady={(ready) => lobbyTransport.ready(ready)} onStart={() => lobbyTransport.startSelection()} onChat={(message) => lobbyTransport.chat(message)} onAddAi={() => lobbyTransport.addAi()} onRemoveAi={(userId) => lobbyTransport.removeAi(userId)} onBack={() => setScreen("access")} />;

  return <AccessScreen viewer={viewer} busy={busy} error={surfaceError} onGuest={guestLogin} onStart={() => { setSurfaceError(""); setScreen("lobby"); }} />;
}
