import { Client, Room, ServerError, type AuthContext } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
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
  type ResolvedRoomOptions,
} from "@five-days/protocol";
import {
  DoorState,
  DropState,
  EnemyState,
  PartyRoomState,
  PlayerState,
  RoomState,
  StructureState,
  UpgradeChoiceState,
  WaypointState,
} from "./state";

const usedTickets = new Map<string, number>();
const FINALIZE_ATTEMPT_TIMEOUT_MS = 3_000;
const FINALIZE_RETRY_DELAYS_MS = [250, 750] as const;

export class OperationTimeoutError extends Error {
  constructor(
    readonly attempt: number,
    readonly timeoutMs: number,
  ) {
    super(`Operation attempt ${attempt} exceeded ${timeoutMs}ms`);
    this.name = "OperationTimeoutError";
  }
}

export type BoundedRetryOptions = {
  attemptTimeoutMs: number;
  retryDelaysMs: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (error: unknown, nextAttempt: number, delayMs: number) => void;
};

export async function runWithTimeoutAndRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: BoundedRetryOptions,
): Promise<T> {
  if (!Number.isFinite(options.attemptTimeoutMs) || options.attemptTimeoutMs <= 0) {
    throw new RangeError("attemptTimeoutMs must be a positive finite number");
  }
  if (options.retryDelaysMs.some((delayMs) => !Number.isFinite(delayMs) || delayMs < 0)) {
    throw new RangeError("retry delays must be finite non-negative numbers");
  }

  const sleep = options.sleep ?? wait;
  let lastError: unknown = new Error("Operation did not run");
  const attemptCount = options.retryDelaysMs.length + 1;
  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    try {
      return await withTimeout(() => operation(attempt), options.attemptTimeoutMs, attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attemptCount) break;
      const delayMs = options.retryDelaysMs[attempt - 1];
      options.onRetry?.(error, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  attempt: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new OperationTimeoutError(attempt, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class PartyRoom extends Room<PartyRoomState> {
  maxClients = 3;
  patchRate = 50;
  private core!: GameCore;
  private matchId = "";
  private finalized = false;
  private finalizing: Promise<void> | null = null;
  private allowedUserIds: Set<string> | null = null;
  private persistenceFailure: unknown = null;
  private shutdownStarted = false;
  private roomOptions!: ResolvedRoomOptions;
  private gameplayLocked = false;
  private resultBroadcast = false;
  private readonly createdAt = Date.now();
  private readonly messageWindows = new Map<string, { startedAt: number; count: number }>();
  private readonly commandSequences = new Map<string, number>();

  static async onAuth(token: string, _options: unknown, context: AuthContext): Promise<GameTicketClaims> {
    validateOrigin(context.headers.origin);
    if (!token) throw new ServerError(401, "게임 접속 티켓이 필요합니다.");
    const claims = await verifyGameTicket(token);
    if (!consumeGameTicket(claims)) throw new ServerError(401, "이미 사용된 게임 접속 티켓입니다.");
    return claims;
  }

  async onCreate(rawOptions: unknown): Promise<void> {
    const options = roomOptionsSchema.parse(rawOptions);
    const internalOptions = rawOptions as { allowedUserIds?: unknown };
    if (Array.isArray(internalOptions.allowedUserIds)) {
      this.allowedUserIds = new Set(internalOptions.allowedUserIds.filter((value): value is string => typeof value === "string"));
    }
    this.roomOptions = options;
    this.maxClients = options.partyMode === "solo" ? 1 : 3;
    this.setState(new PartyRoomState());
    this.state.protocolVersion = PROTOCOL_VERSION;
    this.core = new GameCore({
      mode: options.sessionMode,
      difficulty: options.difficulty,
      seed: crypto.randomUUID(),
      minimumPlayers: options.partyMode === "solo" ? 1 : 3,
    });
    this.state.seed = this.core.options.seed;
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

    for (const messageType of [
      "player.input",
      "skill.cast",
      "build.place",
      "build.upgrade",
      "upgrade.choose",
      "room.ready",
      "player.interact",
      "travel.request",
      "recall.request",
      "equipment.equip",
    ] as const) {
      this.onMessage(messageType, (client, message) => this.handleCommand(client, messageType, message));
    }
    this.setSimulationInterval((deltaMs) => this.simulate(deltaMs), 50);
  }

  onJoin(client: Client, rawOptions: unknown, auth: GameTicketClaims): void {
    if (this.allowedUserIds && !this.allowedUserIds.has(auth.sub)) {
      throw new ServerError(403, "이 게임방의 파티원이 아닙니다.");
    }
    const options = roomOptionsSchema.parse(rawOptions);
    if (
      options.partyMode !== this.roomOptions.partyMode
      || options.sessionMode !== this.roomOptions.sessionMode
      || options.difficulty !== this.roomOptions.difficulty
    ) {
      throw new ServerError(409, "파티 설정이 일치하지 않습니다.");
    }
    if (this.gameplayLocked && !this.core.players.has(auth.sub)) {
      throw new ServerError(409, "이미 출발한 원정에는 새로 참가할 수 없습니다.");
    }
    for (const duplicate of this.clients) {
      if (duplicate !== client && duplicate.auth?.sub === auth.sub) {
        duplicate.leave(4009, "DUPLICATE_LOGIN");
      }
    }
    const player = this.core.addPlayer({
      userId: auth.sub,
      displayName: auth.displayName,
      heroClass: options.heroClass,
    });
    player.lastSeq = -1;
    client.userData = { userId: auth.sub };
    const state = this.state.players.get(player.userId) ?? new PlayerState();
    state.userId = player.userId;
    state.displayName = player.displayName;
    state.heroClass = player.heroClass;
    this.state.players.set(player.userId, state);
    this.syncState();
    this.initializeClientView(client, player.userId);
  }

  async onLeave(client: Client, consented: boolean): Promise<void> {
    const userId = client.userData?.userId as string | undefined;
    if (!userId) return;
    const replaced = this.hasActiveClient(userId, client);
    if (replaced) {
      this.core.setConnected(userId, true);
      this.clearClientTracking(client.sessionId);
      this.syncState();
      return;
    }
    this.core.setConnected(userId, false);
    this.syncState();
    if (consented) {
      this.clearClientTracking(client.sessionId);
      return;
    }
    try {
      const reconnected = await this.allowReconnection(client, 20);
      reconnected.userData = { userId };
      const activeReplacement = this.findActiveClient(userId, reconnected);
      if (activeReplacement) {
        reconnected.leave(4009, "DUPLICATE_LOGIN");
        this.clearClientTracking(reconnected.sessionId);
        this.core.setConnected(userId, true);
        this.syncState();
        return;
      }
      this.core.setConnected(userId, true);
      this.initializeClientView(reconnected, userId);
    } catch {
      this.core.setConnected(userId, this.hasActiveClient(userId, client));
      this.clearClientTracking(client.sessionId);
    }
    this.syncState();
  }

  async onDispose(): Promise<void> {
    if (!this.core || this.finalized) return;
    if (!this.core.result) this.core.finish("abandoned", "모든 용사가 원정을 떠났습니다.");
    try {
      await this.ensureResultPersisted();
    } catch (error) {
      console.error("Failed to persist match during room disposal", error);
    }
  }

  private handleCommand(client: Client, expectedType: ClientCommand["type"], raw: unknown): void {
    if (!this.allowMessage(client.sessionId)) {
      client.send("protocol-error", { code: "RATE_LIMITED" });
      return;
    }
    const parsed = clientCommandSchema.safeParse(raw);
    if (!parsed.success || parsed.data.type !== expectedType || JSON.stringify(raw).length > 4096) {
      client.send("protocol-error", { code: "INVALID_MESSAGE" });
      return;
    }
    const userId = client.userData?.userId as string;
    const command = parsed.data as ClientCommand;
    const lastSequence = this.commandSequences.get(client.sessionId) ?? -1;
    if (command.seq <= lastSequence) {
      this.reject(client, "STALE_SEQUENCE");
      return;
    }
    this.commandSequences.set(client.sessionId, command.seq);
    if (command.type === "player.input") {
      this.core.applyInput(userId, playerInputSchema.parse(command));
      return;
    }
    if (command.type === "room.ready") {
      if (!this.core.setReady(userId, command.payload.ready)) this.reject(client, "READY_REJECTED");
      return;
    }
    if (command.type === "upgrade.choose") {
      if (!this.core.chooseUpgrade(userId, command.payload.draftId, command.payload.upgradeId)) {
        this.reject(client, "UPGRADE_REJECTED");
      }
      return;
    }
    if (command.type === "player.interact") {
      if (!this.core.interact(userId, command.payload.targetId)) this.reject(client, "INTERACTION_REJECTED");
      return;
    }
    if (command.type === "travel.request") {
      if (!this.core.requestTravel(userId, command.payload.waypointId, command.payload.destinationId)) {
        this.reject(client, "TRAVEL_REJECTED");
      }
      return;
    }
    if (command.type === "recall.request") {
      if (!this.core.recall(userId)) this.reject(client, "RECALL_REJECTED");
      return;
    }
    if (command.type === "equipment.equip") {
      if (!this.core.equipDrop(userId, command.payload.dropId)) this.reject(client, "EQUIPMENT_REJECTED");
      return;
    }
    if (command.type === "skill.cast") {
      this.reject(client, "SKILL_NOT_READY");
      return;
    }
    if (command.type === "build.place" || command.type === "build.upgrade") {
      this.reject(client, "BUILD_NOT_READY");
    }
  }

  private simulate(deltaMs: number): void {
    this.core.update(Math.min(deltaMs, 100) / 1000);
    if (Date.now() - this.createdAt >= 35 * 60 * 1000 && this.core.phase !== "ended") {
      this.core.finish("abandoned", "원정 최대 진행 시간 35분을 초과했습니다.");
    }
    if (!this.gameplayLocked && this.core.phase !== "lobby") {
      this.gameplayLocked = true;
      this.lock();
    }
    this.syncState();
    if (this.core.phase === "ended") {
      if (!this.resultBroadcast) {
        this.resultBroadcast = true;
        this.broadcast("result", {
          state: this.core.result ?? "abandoned",
          reason: this.core.resultReason,
        });
      }
      if (!this.shutdownStarted) {
        this.shutdownStarted = true;
        void this.finalizeAndDisconnect();
      }
    }
  }

  private syncState(): void {
    this.state.phase = this.core.phase;
    this.state.resultState = this.core.result ?? "";
    this.state.resultReason = this.core.resultReason;
    this.state.day = this.core.day;
    this.state.serverTime = Date.now();
    this.state.elapsed = this.core.elapsed;
    this.state.phaseEndsAt = this.core.phaseRemaining > 0 ? Date.now() + this.core.phaseRemaining * 1000 : 0;
    this.state.baseHp = this.core.baseHp;
    this.state.baseMaxHp = this.core.baseMaxHp;
    this.state.gold = this.core.gold;
    this.state.currentZone = this.core.currentZone;
    this.state.teamLevel = this.core.teamLevel;
    this.state.teamXp = this.core.teamXp;
    this.state.teamXpToNext = this.core.teamXpToNext;
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
        roomId: player.roomId,
        x: player.x,
        y: player.y,
        aim: player.aim,
        hp: player.hp,
        maxHp: player.maxHp,
        level: player.level,
        teamPower: player.teamPower,
        damage: player.damage,
        bossDamage: player.bossDamage,
        kills: player.kills,
        deaths: player.deaths,
        structuresBuilt: player.structuresBuilt,
        goldSpent: player.goldSpent,
        gatesDestroyed: player.gatesDestroyed,
        alive: player.alive,
        ready: player.ready,
        connected: player.connected,
      });
      const bonuses = this.core.equipmentSummary(player.userId);
      Object.assign(state.equipment, {
        weaponId: player.equipment.weapon?.id ?? "",
        weaponRarity: player.equipment.weapon?.rarity ?? "",
        armorId: player.equipment.armor?.id ?? "",
        armorRarity: player.equipment.armor?.rarity ?? "",
        accessoryId: player.equipment.accessory?.id ?? "",
        accessoryRarity: player.equipment.accessory?.rarity ?? "",
        attackBonus: bonuses?.attackBonus ?? 0,
        maxHpBonus: bonuses?.maxHpBonus ?? 0,
        defenseBonus: bonuses?.defenseBonus ?? 0,
        attackSpeedBonus: bonuses?.attackSpeedBonus ?? 0,
      });
      const draft = player.upgradeDraft;
      const nextDraftId = draft?.draftId ?? "";
      const draftChanged = state.upgradeDraft.draftId !== nextDraftId;
      state.upgradeDraft.draftId = nextDraftId;
      state.upgradeDraft.level = draft?.level ?? 0;
      state.upgradeDraft.active = Boolean(draft);
      state.upgradeDraft.expiresAt = draft?.expiresAt ?? 0;
      if (draftChanged) {
        state.upgradeDraft.choices.splice(0, state.upgradeDraft.choices.length);
        draft?.choices.forEach((choice, order) => {
          const choiceState = new UpgradeChoiceState();
          Object.assign(choiceState, {
            upgradeId: choice.id,
            name: choice.name,
            description: choice.description,
            rarity: choice.rarity,
            stack: player.upgrades[choice.id] ?? 0,
            maxStacks: choice.maxStacks,
            order,
          });
          state.upgradeDraft.choices.push(choiceState);
        });
      }
    }

    for (const room of this.core.rooms.values()) {
      if (!room.discovered) continue;
      let state = this.state.rooms.get(room.id);
      if (!state) {
        state = new RoomState();
        this.state.rooms.set(room.id, state);
      }
      Object.assign(state, {
        id: room.id,
        zone: room.zone,
        gridX: room.gridX,
        gridY: room.gridY,
        kind: room.kind,
        depth: room.depth,
        discovered: room.discovered,
        cleared: room.cleared,
      });
    }

    for (const door of this.core.doors.values()) {
      if (!this.core.discoveredRooms.has(door.fromRoomId) && !this.core.discoveredRooms.has(door.toRoomId)) continue;
      let state = this.state.doors.get(door.id);
      if (!state) {
        state = new DoorState();
        this.state.doors.set(door.id, state);
      }
      Object.assign(state, door);
    }

    for (const enemy of this.core.enemies.values()) {
      if (!this.core.discoveredRooms.has(enemy.roomId)) continue;
      let state = this.state.enemies.get(enemy.id);
      if (!state) {
        state = new EnemyState();
        this.state.enemies.set(enemy.id, state);
      }
      Object.assign(state, {
        id: enemy.id,
        kind: enemy.kind,
        behavior: enemy.behavior,
        roomId: enemy.roomId,
        spawnRoomId: enemy.spawnRoomId,
        targetId: enemy.targetId ?? "",
        x: enemy.x,
        y: enemy.y,
        hp: enemy.hp,
        maxHp: enemy.maxHp,
        alive: enemy.alive,
      });
    }

    for (const waypoint of this.core.waypoints.values()) {
      if (!this.core.discoveredRooms.has(waypoint.roomId)) continue;
      let state = this.state.waypoints.get(waypoint.id);
      if (!state) {
        state = new WaypointState();
        this.state.waypoints.set(waypoint.id, state);
      }
      Object.assign(state, {
        id: waypoint.id,
        roomId: waypoint.roomId,
        kind: waypoint.kind,
        destinationId: waypoint.destinationId,
        active: waypoint.active,
        requiredPlayers: waypoint.requiredPlayers,
        holdingPlayers: waypoint.holdingPlayers,
        holdProgress: waypoint.holdProgress,
        holdDurationMs: waypoint.holdDurationMs,
      });
    }

    const liveDropIds = new Set<string>();
    for (const drop of this.core.drops.values()) {
      liveDropIds.add(drop.id);
      let state = this.state.drops.get(drop.id);
      if (!state) {
        state = new DropState();
        this.state.drops.set(drop.id, state);
        this.addPrivateStateToOwner(drop.ownerPlayerId, state);
      }
      Object.assign(state, {
        id: drop.id,
        ownerUserId: drop.ownerPlayerId,
        roomId: drop.roomId,
        itemId: drop.id,
        slot: drop.slot,
        rarity: drop.rarity,
        x: drop.x,
        y: drop.y,
        specialOptionCount: drop.specialOptionCount,
        claimed: drop.claimed,
      });
    }
    this.state.drops.forEach((_drop, id) => {
      if (!liveDropIds.has(id)) this.state.drops.delete(id);
    });
  }

  private reject(client: Client, code: string): void {
    client.send("protocol-error", { code });
  }

  private hasActiveClient(userId: string, excluded: Client): boolean {
    return Boolean(this.findActiveClient(userId, excluded));
  }

  private findActiveClient(userId: string, excluded: Client): Client | undefined {
    return [...this.clients].find((candidate) => (
      candidate !== excluded && candidate.userData?.userId === userId
    ));
  }

  private initializeClientView(client: Client, userId: string): void {
    const view = new StateView();
    client.view = view;
    const player = this.state.players.get(userId);
    if (player) view.add(player.upgradeDraft);
    this.state.drops.forEach((drop) => {
      if (drop.ownerUserId === userId) view.add(drop);
    });
  }

  private addPrivateStateToOwner(userId: string, state: DropState): void {
    for (const client of this.clients) {
      if (client.userData?.userId === userId) client.view?.add(state);
    }
  }

  private clearClientTracking(sessionId: string): void {
    this.messageWindows.delete(sessionId);
    this.commandSequences.delete(sessionId);
  }

  private ensureResultPersisted(): Promise<void> {
    if (this.finalized) return Promise.resolve();
    if (this.finalizing) return this.finalizing;
    if (this.persistenceFailure) return Promise.reject(this.persistenceFailure);

    // Process-local retries bound room shutdown time. Crash-safe delivery still needs a durable outbox/job queue.
    const attempt = runWithTimeoutAndRetry(
      () => this.persistResult(),
      {
        attemptTimeoutMs: FINALIZE_ATTEMPT_TIMEOUT_MS,
        retryDelaysMs: FINALIZE_RETRY_DELAYS_MS,
        onRetry: (error, nextAttempt, delayMs) => {
          console.warn(`Retrying match result persistence (attempt ${nextAttempt}) after ${delayMs}ms`, error);
        },
      },
    )
      .then(() => {
        this.finalized = true;
      })
      .catch((error) => {
        this.persistenceFailure = error;
        throw error;
      })
      .finally(() => {
        if (this.finalizing === attempt) this.finalizing = null;
      });
    this.finalizing = attempt;
    return attempt;
  }

  private async finalizeAndDisconnect(): Promise<void> {
    try {
      await this.ensureResultPersisted();
    } catch (error) {
      console.error("Failed to persist match result after bounded retries", error);
    } finally {
      try {
        await this.disconnect();
      } catch (error) {
        console.error("Failed to disconnect ended match room", error);
      }
    }
  }

  private async persistResult(): Promise<void> {
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

export function consumeGameTicket(claims: Pick<GameTicketClaims, "jti" | "exp">, now = Date.now()): boolean {
  for (const [jti, expiresAt] of usedTickets) if (expiresAt <= now) usedTickets.delete(jti);
  if (usedTickets.has(claims.jti)) return false;
  usedTickets.set(claims.jti, (claims.exp ?? Math.floor(now / 1000) + 90) * 1000);
  return true;
}

function validateOrigin(origin: string | undefined): void {
  const allowed = new Set(
    (process.env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  );
  if (!origin && process.env.NODE_ENV !== "production") return;
  if (!origin || !allowed.has(origin)) throw new ServerError(403, "허용되지 않은 게임 서버 Origin입니다.");
}

export { PARTY_ROOM };
