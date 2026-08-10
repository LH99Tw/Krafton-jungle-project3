import { Client, type Room } from "colyseus.js";
import {
  LOBBY_ROOM,
  PROTOCOL_VERSION,
  type HeroClassId,
  type LobbyChatMessage,
  type LobbyCreateOptions,
  type LobbyGameStart,
  type LobbyListing,
  type LobbyPhase,
} from "@five-days/protocol";

export type LobbyPlayer = {
  userId: string;
  displayName: string;
  ready: boolean;
  heroClass: HeroClassId | null;
  connected: boolean;
  inGame: boolean;
  joinedAt: number;
  isAi: boolean;
};

export type LobbySnapshot = {
  roomId: string;
  roomName: string;
  hostId: string;
  phase: LobbyPhase;
  sessionMode: "prototype" | "full";
  difficulty: "easy" | "normal" | "hard";
  players: LobbyPlayer[];
};

type RawLobbyState = Omit<LobbySnapshot, "roomId" | "players"> & {
  players: { values(): IterableIterator<LobbyPlayer & { heroClass: string }> };
};

type LobbyEventMap = {
  snapshot: LobbySnapshot;
  chat: LobbyChatMessage;
  history: LobbyChatMessage[];
  start: LobbyGameStart;
  error: { code: string; message: string };
  disconnected: { code: number; reason: string };
};

export class LobbyTransport {
  private room: Room<RawLobbyState> | null = null;
  private readonly listeners = new Map<keyof LobbyEventMap, Set<(value: never) => void>>();

  on<K extends keyof LobbyEventMap>(event: K, callback: (value: LobbyEventMap[K]) => void): () => void {
    const callbacks = this.listeners.get(event) ?? new Set();
    callbacks.add(callback as (value: never) => void);
    this.listeners.set(event, callbacks);
    return () => callbacks.delete(callback as (value: never) => void);
  }

  async list(serverUrl: string): Promise<LobbyListing[]> {
    const endpoint = serverUrl.replace(/^ws/, "http").replace(/\/$/, "");
    try {
      const response = await fetch(`${endpoint}/lobbies`, { cache: "no-store" });
      if (!response.ok) return [];
      const text = await response.text();
      return text ? (JSON.parse(text) as LobbyListing[]) : [];
    } catch {
      return [];
    }
  }

  async create(input: {
    serverUrl: string;
    csrfToken: string;
    options: Omit<LobbyCreateOptions, "protocolVersion">;
  }): Promise<void> {
    await this.connect(input.serverUrl, input.csrfToken, (client) => client.create(LOBBY_ROOM, {
      ...input.options,
      protocolVersion: PROTOCOL_VERSION,
    }));
  }

  async join(input: { serverUrl: string; csrfToken: string; roomId: string }): Promise<void> {
    await this.connect(input.serverUrl, input.csrfToken, (client) => client.joinById(input.roomId, {
      protocolVersion: PROTOCOL_VERSION,
    }));
  }

  ready(ready: boolean): void {
    this.room?.send("lobby.ready", { ready });
  }

  startSelection(): void {
    this.room?.send("lobby.start-selection");
  }

  selectClass(heroClass: HeroClassId | null): void {
    this.room?.send("lobby.class-select", { heroClass });
  }

  chat(message: string): void {
    this.room?.send("lobby.chat", { message });
  }

  returnFromGame(): void {
    this.room?.send("lobby.return");
  }

  addAi(): void {
    this.room?.send("lobby.ai-add");
  }

  removeAi(userId: string): void {
    this.room?.send("lobby.ai-remove", { userId });
  }

  async leave(): Promise<void> {
    const room = this.room;
    this.room = null;
    room?.removeAllListeners();
    if (room) await room.leave(true);
  }

  private async connect(
    serverUrl: string,
    csrfToken: string,
    join: (client: Client) => Promise<Room>,
  ): Promise<void> {
    await this.leave();
    const token = await fetchTicket(csrfToken);
    const client = new Client(serverUrl);
    client.auth.token = token;
    this.room = await join(client) as Room<RawLobbyState>;
    this.room.onStateChange((state) => this.emit("snapshot", toSnapshot(this.room!.roomId, state)));
    this.room.onMessage("lobby.chat", (message: LobbyChatMessage) => this.emit("chat", message));
    this.room.onMessage("lobby.chat-history", (messages: LobbyChatMessage[]) => this.emit("history", messages));
    this.room.onMessage("lobby.game-start", (event: LobbyGameStart) => this.emit("start", event));
    this.room.onMessage("lobby.error", (error: { code: string; message: string }) => this.emit("error", error));
    this.room.onLeave((code, reason) => {
      if (this.room) this.emit("disconnected", { code, reason: reason ?? "대기실 연결이 종료되었습니다." });
    });
  }

  private emit<K extends keyof LobbyEventMap>(event: K, value: LobbyEventMap[K]): void {
    for (const callback of this.listeners.get(event) ?? []) callback(value as never);
  }
}

async function fetchTicket(csrfToken: string): Promise<string> {
  const response = await fetch("/api/game-ticket", {
    method: "POST",
    headers: { "x-csrf-token": csrfToken },
  });
  const text = await response.text();
  let value: { token?: string; error?: string } = {};
  try { value = text ? JSON.parse(text) as typeof value : {}; } catch { /* handled below */ }
  if (!response.ok || !value.token || value.token.split(".").length !== 3) {
    throw new Error(value.error || "게임 접속 티켓을 발급하지 못했습니다.");
  }
  return value.token;
}

function toSnapshot(roomId: string, state: RawLobbyState): LobbySnapshot {
  return {
    roomId,
    roomName: state.roomName,
    hostId: state.hostId,
    phase: state.phase,
    sessionMode: state.sessionMode,
    difficulty: state.difficulty,
    players: [...state.players.values()].map((player) => ({
      userId: player.userId,
      displayName: player.displayName,
      ready: player.ready,
      heroClass: ["swordsman", "archer", "mage"].includes(player.heroClass)
        ? player.heroClass as HeroClassId
        : null,
      connected: player.connected,
      inGame: player.inGame,
      joinedAt: player.joinedAt,
      isAi: player.isAi,
    })),
  };
}

export const lobbyTransport = new LobbyTransport();
