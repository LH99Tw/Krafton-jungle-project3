import { Client, Room, ServerError, type AuthContext } from "@colyseus/core";
import { verifyGameTicket, type GameTicketClaims } from "@five-days/auth";
import { createMatch, finalizeMatch } from "@five-days/db/repositories";
import { GameCore } from "@five-days/game-core";
import {
  PARTY_ROOM,
  PROTOCOL_VERSION,
  clientCommandSchema,
  playerInputSchema,
  roomOptionsSchema,
  type ClientCommand,
  type RoomOptions,
} from "@five-days/protocol";
import { PartyRoomState, PlayerState } from "./state.js";

const usedTickets = new Map<string, number>();

export class PartyRoom extends Room<{ state: PartyRoomState }> {
  maxClients = 3;
  patchRate = 50;
  private core!: GameCore;
  private matchId = "";
  private finalized = false;
  private readonly messageWindows = new Map<string, { startedAt: number; count: number }>();

  static async onAuth(token: string, _options: unknown, _context: AuthContext): Promise<GameTicketClaims> {
    if (!token) throw new ServerError(401, "게임 접속 티켓이 필요합니다.");
    const claims = await verifyGameTicket(token);
    const now = Date.now();
    for (const [jti, expiresAt] of usedTickets) if (expiresAt <= now) usedTickets.delete(jti);
    if (usedTickets.has(claims.jti)) throw new ServerError(401, "이미 사용된 게임 접속 티켓입니다.");
    usedTickets.set(claims.jti, (claims.exp ?? Math.floor(now / 1000) + 90) * 1000);
    return claims;
  }

  async onCreate(rawOptions: unknown): Promise<void> {
    const options = roomOptionsSchema.parse(rawOptions) as RoomOptions;
    this.setState(new PartyRoomState());
    this.state.protocolVersion = PROTOCOL_VERSION;
    this.core = new GameCore({
      mode: options.sessionMode,
      difficulty: options.difficulty,
      seed: crypto.randomUUID(),
      minimumPlayers: Number(process.env.MINIMUM_PLAYERS ?? 3),
    });
    const match = await createMatch({
      roomId: this.roomId,
      mode: options.sessionMode,
      difficulty: options.difficulty,
      seed: this.core.options.seed,
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: process.env.SERVER_VERSION ?? "development",
    });
    this.matchId = match.id;
    this.state.matchId = match.id;

    this.onMessage("player.input", (client, message) => this.handleCommand(client, message));
    this.onMessage("skill.cast", (client, message) => this.handleCommand(client, message));
    this.onMessage("build.place", (client, message) => this.handleCommand(client, message));
    this.onMessage("build.upgrade", (client, message) => this.handleCommand(client, message));
    this.onMessage("upgrade.choose", (client, message) => this.handleCommand(client, message));
    this.onMessage("room.ready", (client, message) => this.handleCommand(client, message));
    this.setSimulationInterval((deltaMs) => this.simulate(deltaMs), 50);
  }

  onJoin(client: Client, rawOptions: unknown, auth: GameTicketClaims): void {
    const options = roomOptionsSchema.parse(rawOptions);
    const duplicate = [...this.clients].find((item) => item !== client && item.auth?.sub === auth.sub);
    duplicate?.leave(4009, "DUPLICATE_LOGIN");
    const player = this.core.addPlayer({
      userId: auth.sub,
      displayName: auth.displayName,
      heroClass: options.heroClass,
    });
    client.userData = { userId: auth.sub };
    const state = new PlayerState();
    state.userId = player.userId;
    state.displayName = player.displayName;
    state.heroClass = player.heroClass;
    this.state.players.set(player.userId, state);
    this.syncState();
  }

  async onDrop(client: Client): Promise<void> {
    const userId = client.userData?.userId as string | undefined;
    if (userId) this.core.setConnected(userId, false);
    this.syncState();
    try {
      await this.allowReconnection(client, 20);
    } catch {
      this.syncState();
    }
  }

  onReconnect(client: Client): void {
    const userId = client.userData?.userId as string | undefined;
    if (userId) this.core.setConnected(userId, true);
    this.syncState();
  }

  async onDispose(): Promise<void> {
    if (!this.core || this.finalized) return;
    if (!this.core.result) this.core.finish("abandoned", "모든 용사가 원정을 떠났습니다.");
    await this.persistResult();
  }

  private handleCommand(client: Client, raw: unknown): void {
    if (!this.allowMessage(client.sessionId)) {
      client.send("protocol-error", { code: "RATE_LIMITED" });
      return;
    }
    const parsed = clientCommandSchema.safeParse(raw);
    if (!parsed.success || JSON.stringify(raw).length > 4096) {
      client.send("protocol-error", { code: "INVALID_MESSAGE" });
      return;
    }
    const userId = client.userData?.userId as string;
    const command = parsed.data as ClientCommand;
    if (command.type === "player.input") this.core.applyInput(userId, playerInputSchema.parse(command));
    else if (command.type === "room.ready") this.core.setReady(userId, command.payload.ready);
    else if (command.type === "skill.cast") {
      // Combat validation and effects are added as GameScene rules move into game-core.
    } else if (command.type.startsWith("build.")) {
      // Build placement remains rejected until the server-side path validator is extracted.
      client.send("protocol-error", { code: "BUILD_NOT_READY" });
    }
  }

  private simulate(deltaMs: number): void {
    this.core.update(Math.min(deltaMs, 100) / 1000);
    this.syncState();
    if (this.core.phase === "ended" && !this.finalized) {
      void this.persistResult().finally(() => this.disconnect());
    }
  }

  private syncState(): void {
    this.state.phase = this.core.phase;
    this.state.day = this.core.day;
    this.state.serverTime = Date.now();
    this.state.phaseEndsAt = this.core.phaseRemaining > 0 ? Date.now() + this.core.phaseRemaining * 1000 : 0;
    this.state.baseHp = this.core.baseHp;
    this.state.gold = this.core.gold;
    for (const player of this.core.players.values()) {
      let state = this.state.players.get(player.userId);
      if (!state) {
        state = new PlayerState();
        this.state.players.set(player.userId, state);
      }
      Object.assign(state, {
        userId: player.userId,
        displayName: player.displayName,
        heroClass: player.heroClass,
        x: player.x,
        y: player.y,
        aim: player.aim,
        hp: player.hp,
        maxHp: player.maxHp,
        level: player.level,
        teamPower: player.teamPower,
        ready: player.ready,
        connected: player.connected,
      });
    }
  }

  private async persistResult(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    await finalizeMatch({
      matchId: this.matchId,
      state: this.core.result ?? "server_error",
      reason: this.core.resultReason || "게임 서버가 종료되었습니다.",
      day: this.core.day,
      durationSeconds: this.core.elapsed,
      players: [...this.core.players.values()].map((player) => ({
        userId: player.userId,
        heroClass: player.heroClass,
        level: player.level,
        teamPower: player.teamPower,
        damage: player.damage,
        bossDamage: player.bossDamage,
        kills: player.kills,
        deaths: player.deaths,
        structuresBuilt: player.structuresBuilt,
        goldSpent: player.goldSpent,
        gatesDestroyed: player.gatesDestroyed,
        disconnected: !player.connected,
      })),
    });
  }

  private allowMessage(sessionId: string): boolean {
    const now = Date.now();
    const window = this.messageWindows.get(sessionId);
    if (!window || now - window.startedAt >= 1000) {
      this.messageWindows.set(sessionId, { startedAt: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= 30;
  }
}

export { PARTY_ROOM };
