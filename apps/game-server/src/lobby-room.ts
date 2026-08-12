import { matchMaker, Room, ServerError, type AuthContext, type Client } from "@colyseus/core";
import { type GameTicketClaims } from "@five-days/auth";
import { OFFICIAL_MAP_MANIFEST } from "@five-days/game-core";
import {
  LOBBY_ROOM,
  PARTY_ROOM,
  PROTOCOL_VERSION,
  lobbyAiRemoveSchema,
  lobbyClassSelectSchema,
  lobbyCreateOptionsSchema,
  lobbyReadySchema,
  type LobbyGameStart,
} from "@five-days/protocol";
import {
  authorizeGameConnection,
  hasRegisteredConnection,
  numericEnv,
  recordProtocolViolation,
  registerConnection,
  unregisterConnection,
} from "./security";
import { LobbyPlayerState, LobbyRoomState } from "./state";

type LobbyMetadata = {
  roomName: string;
  phase: "waiting" | "selecting" | "in_game";
  sessionMode: "prototype" | "full";
  difficulty: "easy" | "normal" | "hard";
  partySize: number;
};

const CHARACTER_SELECTION_LAUNCH_DELAY_MS = 2_000;

export class GameLobbyRoom extends Room<LobbyRoomState, LobbyMetadata> {
  maxClients = 3;
  patchRate = 100;
  private gameStarting = false;
  private selectionLaunchTimer: { clear(): void } | null = null;
  private readonly messageWindows = new Map<string, { startedAt: number; count: number }>();

  static async onAuth(token: string, _options: unknown, context: AuthContext): Promise<GameTicketClaims> {
    return authorizeGameConnection(token, context, "lobby");
  }

  async onCreate(rawOptions: unknown): Promise<void> {
    const activeLobbies = await matchMaker.query({ name: LOBBY_ROOM });
    const otherLobbies = activeLobbies.filter((room) => room.roomId !== this.roomId);
    if (otherLobbies.length >= numericEnv("MAX_ACTIVE_LOBBIES", 100, 1, 1_000)) {
      throw new ServerError(503, "활성 원정대 한도에 도달했습니다.");
    }
    const options = lobbyCreateOptionsSchema.parse(rawOptions);
    this.setState(new LobbyRoomState());
    this.state.roomName = options.roomName;
    this.state.sessionMode = options.sessionMode;
    this.state.difficulty = options.difficulty;
    this.onMessage("lobby.ready", (client, message) => this.guard(client, () => this.setReady(client, message)));
    this.onMessage("lobby.start-selection", (client) => this.guard(client, () => this.startSelection(client)));
    this.onMessage("lobby.class-select", (client, message) => this.guard(client, () => this.selectClass(client, message)));
    this.onMessage("lobby.return", (client) => this.guard(client, () => this.returnFromGame(client)));
    this.onMessage("lobby.ai-add", (client) => this.guard(client, () => this.addAi(client)));
    this.onMessage("lobby.ai-remove", (client, message) => this.guard(client, () => this.removeAi(client, message)));
    await this.syncMetadata();
  }

  onJoin(client: Client, _options: unknown, auth: GameTicketClaims): void {
    const duplicate = [...this.clients].find((item) => item !== client && item.auth?.sub === auth.sub);
    duplicate?.leave(4009, "DUPLICATE_LOGIN");
    if (!this.state.players.has(auth.sub) && this.state.players.size >= 3) {
      throw new ServerError(4210, "파티 슬롯이 모두 찼습니다.");
    }
    client.userData = { userId: auth.sub };
    registerConnection("lobby", auth.sub, client);
    const player = new LobbyPlayerState();
    player.userId = auth.sub;
    player.displayName = auth.displayName;
    player.joinedAt = Date.now();
    this.state.players.set(auth.sub, player);
    if (!this.state.hostId) this.state.hostId = auth.sub;
    void this.syncMetadata();
  }

  async onLeave(client: Client, consented: boolean): Promise<void> {
    const userId = client.userData?.userId as string | undefined;
    const player = userId ? this.state.players.get(userId) : undefined;
    if (!userId || !player) return;
    if (!consented) {
      player.connected = false;
      try {
        const reconnected = await this.allowReconnection(client, 60);
        reconnected.userData = { userId };
        if (hasRegisteredConnection("lobby", userId, client)) {
          reconnected.leave(4009, "DUPLICATE_LOGIN");
          player.connected = true;
          unregisterConnection("lobby", userId, client);
          this.messageWindows.delete(client.sessionId);
          return;
        }
        player.connected = true;
        registerConnection("lobby", userId, reconnected);
        unregisterConnection("lobby", userId, client);
        this.messageWindows.delete(client.sessionId);
        return;
      } catch {
        // The player is removed below when the reconnection window expires.
      }
    }
    this.state.players.delete(userId);
    this.messageWindows.delete(client.sessionId);
    unregisterConnection("lobby", userId, client);
    if (this.state.hostId === userId) this.assignNextHost();
    if (this.state.phase === "selecting") this.resetToWaiting();
    if (this.state.phase === "in_game" && [...this.state.players.values()].every((item) => !item.inGame)) this.resetToWaiting();
    await this.syncMetadata();
  }

  private setReady(client: Client, raw: unknown): void {
    if (this.state.phase !== "waiting") return this.error(client, "NOT_WAITING", "대기 상태에서만 준비할 수 있습니다.");
    const parsed = lobbyReadySchema.safeParse(raw);
    const player = this.playerFor(client);
    if (!parsed.success || !player) return this.error(client, "INVALID_READY", "준비 요청을 확인할 수 없습니다.");
    player.ready = parsed.data.ready;
  }

  private startSelection(client: Client): void {
    const userId = client.userData?.userId as string | undefined;
    if (userId !== this.state.hostId) return this.error(client, "HOST_ONLY", "방장만 선택을 시작할 수 있습니다.");
    const players = [...this.state.players.values()];
    const humans = players.filter((player) => !player.isAi);
    if (players.length !== 3 || humans.some((player) => !player.ready || !player.connected)) {
      return this.error(client, "PARTY_NOT_READY", "세 명 모두 준비해야 합니다.");
    }
    this.state.phase = "selecting";
    for (const player of humans) player.heroClass = "";
    this.assignAiClasses();
    void this.syncMetadata();
  }

  private selectClass(client: Client, raw: unknown): void {
    if (this.state.phase !== "selecting") return this.error(client, "NOT_SELECTING", "현재 캐릭터를 선택할 수 없습니다.");
    if (this.state.launchAt > 0) return this.error(client, "SELECTION_LOCKED", "출전 준비가 시작되어 캐릭터 선택이 확정되었습니다.");
    const parsed = lobbyClassSelectSchema.safeParse(raw);
    const player = this.playerFor(client);
    if (!parsed.success || !player) return this.error(client, "INVALID_CLASS", "캐릭터 선택을 확인할 수 없습니다.");
    player.heroClass = parsed.data.heroClass ?? "";
    this.assignAiClasses();
    const players = [...this.state.players.values()];
    if (players.length === 3 && players.every((item) => item.heroClass)) this.scheduleGameStart();
  }

  private scheduleGameStart(): void {
    if (this.selectionLaunchTimer || this.gameStarting || this.state.phase !== "selecting") return;
    this.state.launchAt = Date.now() + CHARACTER_SELECTION_LAUNCH_DELAY_MS;
    this.selectionLaunchTimer = this.clock.setTimeout(() => {
      this.selectionLaunchTimer = null;
      const players = [...this.state.players.values()];
      if (this.state.phase !== "selecting" || players.length !== 3 || players.some((player) => !player.heroClass)) {
        this.state.launchAt = 0;
        return;
      }
      void this.startGame();
    }, CHARACTER_SELECTION_LAUNCH_DELAY_MS);
  }

  private cancelScheduledGameStart(): void {
    this.selectionLaunchTimer?.clear();
    this.selectionLaunchTimer = null;
    this.state.launchAt = 0;
  }

  private async startGame(): Promise<void> {
    if (this.gameStarting || this.state.phase !== "selecting") return;
    this.gameStarting = true;
    try {
      const players = [...this.state.players.values()];
      const humans = players.filter((player) => !player.isAi);
      const room = await matchMaker.createRoom(PARTY_ROOM, {
        heroClass: players[0].heroClass,
        sessionMode: this.state.sessionMode,
        difficulty: this.state.difficulty,
        protocolVersion: PROTOCOL_VERSION,
        mapRevision: OFFICIAL_MAP_MANIFEST.mapRevision,
        allowedUserIds: humans.map((player) => player.userId),
        aiPlayers: players.filter((player) => player.isAi).map((player) => ({
          userId: player.userId,
          displayName: player.displayName,
          heroClass: player.heroClass as "swordsman" | "archer" | "mage",
        })),
        minimumPlayers: humans.length,
        lobbyRoomId: this.roomId,
      });
      this.state.phase = "in_game";
      this.state.launchAt = 0;
      for (const player of players) player.inGame = true;
      const payload: LobbyGameStart = {
        gameRoomId: room.roomId,
        sessionMode: this.state.sessionMode as LobbyGameStart["sessionMode"],
        difficulty: this.state.difficulty as LobbyGameStart["difficulty"],
        playerClasses: Object.fromEntries(players.map((player) => [player.userId, player.heroClass])) as Record<string, "swordsman" | "archer" | "mage">,
      };
      this.broadcast("lobby.game-start", payload);
      await this.syncMetadata();
    } catch {
      this.broadcast("lobby.error", { code: "GAME_CREATE_FAILED", message: "게임방을 만들지 못했습니다." });
    } finally {
      this.gameStarting = false;
    }
  }

  private returnFromGame(client: Client): void {
    const player = this.playerFor(client);
    if (!player) return;
    player.inGame = false;
    player.ready = false;
    player.heroClass = "";
    if ([...this.state.players.values()].filter((item) => !item.isAi).every((item) => !item.inGame)) this.resetToWaiting();
  }

  private addAi(client: Client): void {
    const userId = client.userData?.userId as string | undefined;
    if (userId !== this.state.hostId) return this.error(client, "HOST_ONLY", "방장만 AI를 추가할 수 있습니다.");
    if (this.state.phase !== "waiting" || this.state.players.size >= 3) return this.error(client, "NO_AI_SLOT", "AI를 추가할 빈 슬롯이 없습니다.");
    const aiCount = [...this.state.players.values()].filter((player) => player.isAi).length;
    const ai = new LobbyPlayerState();
    ai.userId = `ai:${crypto.randomUUID()}`;
    ai.displayName = ["루엔", "세라", "카인"][aiCount] ?? `지원 AI ${aiCount + 1}`;
    ai.ready = true;
    ai.connected = true;
    ai.isAi = true;
    ai.joinedAt = Date.now();
    this.state.players.set(ai.userId, ai);
    void this.syncMetadata();
  }

  private removeAi(client: Client, raw: unknown): void {
    const userId = client.userData?.userId as string | undefined;
    if (userId !== this.state.hostId) return this.error(client, "HOST_ONLY", "방장만 AI를 제외할 수 있습니다.");
    const parsed = lobbyAiRemoveSchema.safeParse(raw);
    if (this.state.phase !== "waiting" || !parsed.success) return this.error(client, "INVALID_AI", "AI 슬롯을 변경할 수 없습니다.");
    const player = this.state.players.get(parsed.data.userId);
    if (!player?.isAi) return this.error(client, "INVALID_AI", "AI 슬롯을 찾지 못했습니다.");
    this.state.players.delete(parsed.data.userId);
    void this.syncMetadata();
  }

  private assignAiClasses(): void {
    const order = ["swordsman", "archer", "mage"] as const;
    const humans = [...this.state.players.values()].filter((player) => !player.isAi && player.heroClass);
    const available = order.filter((heroClass) => !humans.some((player) => player.heroClass === heroClass));
    [...this.state.players.values()].filter((player) => player.isAi).forEach((player, index) => {
      player.heroClass = available[index] ?? order[index % order.length];
    });
  }

  private resetToWaiting(): void {
    this.cancelScheduledGameStart();
    this.state.phase = "waiting";
    for (const player of this.state.players.values()) {
      player.ready = false;
      player.heroClass = "";
      player.inGame = false;
    }
    void this.syncMetadata();
  }

  private assignNextHost(): void {
    const next = [...this.state.players.values()].filter((player) => !player.isAi).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    this.state.hostId = next?.userId ?? "";
  }

  private playerFor(client: Client): LobbyPlayerState | undefined {
    return this.state.players.get(client.userData?.userId as string);
  }

  private error(client: Client, code: string, message: string): void {
    if (code.startsWith("INVALID_") || code === "MESSAGE_RATE_LIMITED") recordProtocolViolation(client, code);
    client.send("lobby.error", { code, message });
  }

  private guard(client: Client, operation: () => void): void {
    const now = Date.now();
    const current = this.messageWindows.get(client.sessionId);
    if (!current || now - current.startedAt >= 1_000) {
      this.messageWindows.set(client.sessionId, { startedAt: now, count: 1 });
      operation();
      return;
    }
    current.count += 1;
    if (current.count <= 15) operation();
    else this.error(client, "MESSAGE_RATE_LIMITED", "요청이 너무 많습니다.");
  }

  private async syncMetadata(): Promise<void> {
    await this.setMetadata({
      roomName: this.state.roomName,
      phase: this.state.phase as LobbyMetadata["phase"],
      sessionMode: this.state.sessionMode as LobbyMetadata["sessionMode"],
      difficulty: this.state.difficulty as LobbyMetadata["difficulty"],
      partySize: this.state.players.size,
    });
  }
}

export { LOBBY_ROOM };
