import { matchMaker, Room, ServerError, type AuthContext, type Client } from "@colyseus/core";
import { verifyGameTicket, type GameTicketClaims } from "@five-days/auth";
import {
  LOBBY_ROOM,
  PARTY_ROOM,
  PROTOCOL_VERSION,
  lobbyChatSchema,
  lobbyAiRemoveSchema,
  lobbyClassSelectSchema,
  lobbyCreateOptionsSchema,
  lobbyReadySchema,
  type LobbyChatMessage,
  type LobbyGameStart,
} from "@five-days/protocol";
import { consumeGameTicket } from "./party-room";
import { LobbyPlayerState, LobbyRoomState } from "./state";

type LobbyMetadata = {
  roomName: string;
  phase: "waiting" | "selecting" | "in_game";
  sessionMode: "prototype" | "full";
  difficulty: "easy" | "normal" | "hard";
  partySize: number;
};

export class GameLobbyRoom extends Room<LobbyRoomState, LobbyMetadata> {
  maxClients = 3;
  patchRate = 100;
  private readonly messages: LobbyChatMessage[] = [];
  private readonly chatWindows = new Map<string, { startedAt: number; count: number }>();
  private gameStarting = false;

  static async onAuth(token: string, _options: unknown, context: AuthContext): Promise<GameTicketClaims> {
    validateOrigin(context.headers.origin);
    if (!token) throw new ServerError(401, "대기실 접속 티켓이 필요합니다.");
    const claims = await verifyGameTicket(token);
    if (!consumeGameTicket(claims)) throw new ServerError(401, "이미 사용된 접속 티켓입니다.");
    return claims;
  }

  async onCreate(rawOptions: unknown): Promise<void> {
    const options = lobbyCreateOptionsSchema.parse(rawOptions);
    this.setState(new LobbyRoomState());
    this.state.roomName = options.roomName;
    this.state.sessionMode = options.sessionMode;
    this.state.difficulty = options.difficulty;
    this.onMessage("lobby.ready", (client, message) => this.setReady(client, message));
    this.onMessage("lobby.start-selection", (client) => this.startSelection(client));
    this.onMessage("lobby.class-select", (client, message) => this.selectClass(client, message));
    this.onMessage("lobby.chat", (client, message) => this.chat(client, message));
    this.onMessage("lobby.return", (client) => this.returnFromGame(client));
    this.onMessage("lobby.ai-add", (client) => this.addAi(client));
    this.onMessage("lobby.ai-remove", (client, message) => this.removeAi(client, message));
    await this.syncMetadata();
  }

  onJoin(client: Client, _options: unknown, auth: GameTicketClaims): void {
    const duplicate = [...this.clients].find((item) => item !== client && item.auth?.sub === auth.sub);
    duplicate?.leave(4009, "DUPLICATE_LOGIN");
    if (!this.state.players.has(auth.sub) && this.state.players.size >= 3) {
      throw new ServerError(4210, "파티 슬롯이 모두 찼습니다.");
    }
    client.userData = { userId: auth.sub };
    const player = new LobbyPlayerState();
    player.userId = auth.sub;
    player.displayName = auth.displayName;
    player.joinedAt = Date.now();
    this.state.players.set(auth.sub, player);
    if (!this.state.hostId) this.state.hostId = auth.sub;
    client.send("lobby.chat-history", this.messages);
    void this.syncMetadata();
  }

  async onLeave(client: Client, consented: boolean): Promise<void> {
    const userId = client.userData?.userId as string | undefined;
    const player = userId ? this.state.players.get(userId) : undefined;
    if (!userId || !player) return;
    if (!consented) {
      player.connected = false;
      try {
        await this.allowReconnection(client, 20);
        player.connected = true;
        return;
      } catch {
        // The player is removed below when the reconnection window expires.
      }
    }
    this.state.players.delete(userId);
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
    const parsed = lobbyClassSelectSchema.safeParse(raw);
    const player = this.playerFor(client);
    if (!parsed.success || !player) return this.error(client, "INVALID_CLASS", "캐릭터 선택을 확인할 수 없습니다.");
    player.heroClass = parsed.data.heroClass ?? "";
    this.assignAiClasses();
    const players = [...this.state.players.values()];
    if (players.length === 3 && players.every((item) => item.heroClass)) void this.startGame();
  }

  private chat(client: Client, raw: unknown): void {
    const parsed = lobbyChatSchema.safeParse(raw);
    const player = this.playerFor(client);
    if (!parsed.success || !player || /[<>\u0000-\u001f\u007f]/.test(parsed.success ? parsed.data.message : "")) {
      return this.error(client, "INVALID_CHAT", "메시지는 1~180자의 일반 텍스트만 사용할 수 있습니다.");
    }
    if (!this.allowChat(player.userId)) return this.error(client, "CHAT_RATE_LIMITED", "메시지를 너무 빠르게 보내고 있습니다.");
    const message: LobbyChatMessage = {
      id: crypto.randomUUID(),
      userId: player.userId,
      displayName: player.displayName,
      message: parsed.data.message,
      sentAt: Date.now(),
    };
    this.messages.push(message);
    if (this.messages.length > 50) this.messages.shift();
    this.broadcast("lobby.chat", message);
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

  private allowChat(userId: string): boolean {
    const now = Date.now();
    const window = this.chatWindows.get(userId);
    if (!window || now - window.startedAt >= 10_000) {
      this.chatWindows.set(userId, { startedAt: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= 5;
  }

  private error(client: Client, code: string, message: string): void {
    client.send("lobby.error", { code, message });
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

function validateOrigin(origin: string | undefined): void {
  const allowed = new Set(
    (process.env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  );
  if (!origin && process.env.NODE_ENV !== "production") return;
  if (!origin || !allowed.has(origin)) throw new ServerError(403, "허용되지 않은 Origin입니다.");
}

export { LOBBY_ROOM };
