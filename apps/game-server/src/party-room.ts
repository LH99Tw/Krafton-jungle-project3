import { Client, matchMaker, Room, ServerError, type AuthContext } from "@colyseus/core";
import { performance } from "node:perf_hooks";
import { StateView } from "@colyseus/schema";
import { type GameTicketClaims } from "@five-days/auth";
import { createMatch, finalizeMatch } from "@five-days/db/repositories";
import {
  ABSOLUTE_MAX_LIVE_INVADERS,
  BOSS_ROOM_ID,
  DEFAULT_MAX_LIVE_INVADERS,
  GameCore,
  OFFICIAL_MAP_MANIFEST,
  OFFICIAL_WORLD,
  createCoreViewSnapshot,
  type CoreRoomId,
} from "@five-days/game-core";
import {
  PARTY_ROOM,
  PROTOCOL_VERSION,
  clientCommandSchema,
  inputFrameSchema,
  minimapResyncSchema,
  minimapReadySchema,
  playerInputSchema,
  roomOptionsSchema,
  transformFlags,
  type ClientCommand,
  type InputFrame,
  type HeroClassId,
  type ResolvedRoomOptions,
  type TransformSample,
  type WorldFrame,
} from "@five-days/protocol";
import {
  DoorState,
  DropState,
  EnemyState,
  PartyRoomState,
  PLAYER_TRANSFORM_VIEW,
  PlayerState,
  RoomState,
  UpgradeChoiceState,
  WaypointState,
} from "./state";
import {
  authorizeGameConnection,
  hasRegisteredConnection,
  numericEnv,
  recordProtocolViolation,
  registerConnection,
  unregisterConnection,
} from "./security";
import { consumeGameTicketNonce } from "@five-days/db/repositories";
import {
  issueFastLaneOffer,
  registerFastLaneRoom,
  sendFastLaneWorldFrame,
  unbindFastLaneSession,
  unregisterFastLaneRoom,
} from "./fast-lane";
import {
  recordInputLeaseExpiration,
  recordRealtimeInput,
  recordRealtimeWorldFrame,
  recordRealtimeTiming,
  recordRoomInvaderMetrics,
  recordSimulationCatchUp,
  removeRoomInvaderMetrics,
} from "./realtime-metrics";
import { PartyExploration } from "./minimap";

const FINALIZE_ATTEMPT_TIMEOUT_MS = 3_000;
const FINALIZE_RETRY_DELAYS_MS = [250, 750] as const;
const SIMULATION_STEP_MS = 1000 / 60;
const WORLD_FRAME_INTERVAL_TICKS = 2;
const SCHEMA_SYNC_INTERVAL_MS = 100;
const MINIMAP_GEOMETRY_REFRESH_MS = 500;
export const INPUT_LEASE_MS = 100;
const MAX_CATCH_UP_TICKS = 4;
const KEYFRAME_INTERVAL_MS = 500;
const DISCONTINUITY_DISTANCE = 96;
const ENEMY_WORLD_KEYFRAME_TICKS = 60;
const WEBSOCKET_SIZE_SAMPLE_INTERVAL = 30;

type PreviousTransform = { roomId: string; x: number; y: number; at: number; vx: number; vy: number };
type EnemySchemaSnapshot = {
  hp: number; targetId: string; roomId: string; alive: boolean;
  patternKind: string; patternPhase: string; patternRemaining: number;
  patternIndex: number; attackSequence: number;
};

function rolloutBucket(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 100;
}

export function assertOfficialMapRevision(mapRevision: string): void {
  if (mapRevision !== OFFICIAL_MAP_MANIFEST.mapRevision) {
    throw new ServerError(409, "MAP_REVISION_MISMATCH");
  }
}

export class OperationTimeoutError extends Error {
  constructor(
    readonly attempt: number,
    readonly timeoutMs: number,
  ) {
    super(`Operation attempt ${attempt} exceeded ${timeoutMs}ms`);
    this.name = "OperationTimeoutError";
  }
}

type BoundedRetryOptions = {
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

export function partyPlayerIdsForView<T extends { userId: string }>(players: Iterable<T>): Set<string> {
  return new Set([...players].map((player) => player.userId));
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
  patchRate = 100;
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
  private readonly inputMessageWindows = new Map<string, { startedAt: number; count: number }>();
  private readonly reliableCommandSequences = new Map<string, number>();
  private readonly inputSequences = new Map<string, number>();
  private readonly lastInputAt = new Map<string, number>();
  private readonly visibleEnemies = new Map<string, Set<string>>();
  private readonly visibleDrops = new Map<string, Set<string>>();
  private readonly visiblePlayerTransforms = new Map<string, Set<string>>();
  private readonly activeHumanSessions = new Set<string>();
  private readonly schemaRoomIds = new Map<string, string>();
  private readonly previousTransforms = new Map<string, PreviousTransform>();
  private lastEnemyFramePositions = new Map<string, { roomId: string; x: number; y: number; revision?: number }>();
  private enemyIdsByRoom = new Map<string, Set<string>>();
  private enemyRoomMembership = new Map<string, string>();
  private enemySchemaSnapshots = new Map<string, EnemySchemaSnapshot>();
  private clientEnemyViewRevision = new Map<string, { viewerRoomId: string; revision: number }>();
  private enemyMembershipRevision = 0;
  private websocketSizeSamples = 0;
  private lastWebsocketFrameBytes = 0;
  private multirateEnabled = false;
  private aoiRoomCache = new Map<string, ReadonlySet<string>>();
  private simulationAccumulatorMs = 0;
  private serverTick = 0;
  private lastKeyframeAt = 0;
  private exploration!: PartyExploration;
  private explorationAccumulatorMs = 0;
  private schemaSyncAccumulatorMs = 0;

  static async onAuth(token: string, _options: unknown, context: AuthContext): Promise<GameTicketClaims> {
    return authorizeGameConnection(token, context, "party");
  }

  async onCreate(rawOptions: unknown): Promise<void> {
    const activeGames = await matchMaker.query({ name: PARTY_ROOM });
    const otherGames = activeGames.filter((room) => room.roomId !== this.roomId);
    if (otherGames.length >= numericEnv("MAX_ACTIVE_GAMES", 100, 1, 1_000)) {
      throw new ServerError(503, "활성 게임 한도에 도달했습니다.");
    }
    const options = roomOptionsSchema.parse(rawOptions);
    assertOfficialMapRevision(options.mapRevision);
    const internalOptions = rawOptions as { allowedUserIds?: unknown; aiPlayers?: unknown };
    if (Array.isArray(internalOptions.allowedUserIds)) {
      this.allowedUserIds = new Set(internalOptions.allowedUserIds.filter((value): value is string => typeof value === "string"));
    }
    const aiPlayers = Array.isArray(internalOptions.aiPlayers)
      ? internalOptions.aiPlayers.filter((value): value is { userId: string; displayName: string; heroClass: HeroClassId } =>
        Boolean(value) && typeof (value as { userId?: unknown }).userId === "string"
        && typeof (value as { heroClass?: unknown }).heroClass === "string")
      : [];
    this.roomOptions = options;
    this.maxClients = options.partyMode === "solo" ? 1 : 3;
    this.setState(new PartyRoomState());
    this.state.protocolVersion = PROTOCOL_VERSION;
    const multiratePercent = numericEnv("INVADER_MULTIRATE_PERCENT", 10, 0, 100);
    this.multirateEnabled = rolloutBucket(this.roomId) < multiratePercent;
    this.core = new GameCore({
      mode: options.sessionMode,
      difficulty: options.difficulty,
      seed: crypto.randomUUID(),
      minimumPlayers: options.partyMode === "solo" ? 1 : 3,
      maxLiveInvaders: numericEnv("MAX_LIVE_INVADERS", DEFAULT_MAX_LIVE_INVADERS, 32, ABSOLUTE_MAX_LIVE_INVADERS),
      invaderUpdateRates: this.multirateEnabled
        ? {
          warmHz: numericEnv("INVADER_WARM_HZ", 20, 1, 60),
          coldHz: numericEnv("INVADER_COLD_HZ", 10, 1, 60),
        }
        : { warmHz: 60, coldHz: 60 },
      world: OFFICIAL_WORLD,
    });
    this.exploration = new PartyExploration(this.core);
    this.state.seed = this.core.options.seed;
    for (const ai of aiPlayers) {
      const corePlayer = this.core.addPlayer({ userId: ai.userId, displayName: ai.displayName, heroClass: ai.heroClass });
      corePlayer.ready = true;
    }
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
    this.onMessage("input.frame", (client, message) => this.handleInputFrame(client, message, "websocket"));
    this.onMessage("fastlane.request", (client, message) => {
      if ((message as { v?: unknown })?.v !== PROTOCOL_VERSION) return;
      const userId = client.userData?.userId as string | undefined;
      if (userId) this.sendFastLaneOffer(client, userId);
    });
    this.onMessage("minimap.resync", (client, message) => {
      const parsed = minimapResyncSchema.safeParse(message);
      if (!parsed.success) return this.reject(client, "INVALID_MINIMAP_RESYNC");
      const init = this.exploration.init(parsed.data.areaId);
      if (init && init.geometry.mapRevision === parsed.data.mapRevision) client.send("minimap.init", init);
    });
    this.onMessage("minimap.ready", (client, message) => {
      if (!minimapReadySchema.safeParse(message).success) return this.reject(client, "INVALID_MINIMAP_READY");
      for (const init of this.exploration.allInit()) client.send("minimap.init", init);
    });
    registerFastLaneRoom(this.roomId, {
      hasSession: (sessionId, userId) => this.clients.some((client) => (
        client.sessionId === sessionId && client.userData?.userId === userId
      )),
      onInput: (sessionId, frame) => {
        const client = this.clients.find((candidate) => candidate.sessionId === sessionId);
        if (client) this.handleInputFrame(client, frame, "webtransport");
      },
    });
    this.setSimulationInterval((deltaMs) => this.simulate(deltaMs), SIMULATION_STEP_MS);
  }

  onJoin(client: Client, rawOptions: unknown, auth: GameTicketClaims): void {
    if (this.allowedUserIds && !this.allowedUserIds.has(auth.sub)) {
      throw new ServerError(403, "이 게임방의 파티원이 아닙니다.");
    }
    const options = roomOptionsSchema.parse(rawOptions);
    assertOfficialMapRevision(options.mapRevision);
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
    this.inputSequences.set(player.userId, -1);
    this.lastInputAt.set(player.userId, Date.now());
    client.userData = { userId: auth.sub };
    this.activeHumanSessions.add(client.sessionId);
    registerConnection("party", auth.sub, client);
    const state = this.state.players.get(player.userId) ?? new PlayerState();
    state.userId = player.userId;
    state.displayName = player.displayName;
    state.heroClass = player.heroClass;
    this.state.players.set(player.userId, state);
    this.syncState(true);
    this.initializeClientView(client, player.userId);
    this.exploration.update();
    for (const init of this.exploration.allInit()) client.send("minimap.init", init);
    this.sendFastLaneOffer(client, player.userId);
  }

  async onLeave(client: Client, consented: boolean): Promise<void> {
    this.activeHumanSessions.delete(client.sessionId);
    const userId = client.userData?.userId as string | undefined;
    if (!userId) return;
    const replaced = this.hasActiveClient(userId, client);
    if (replaced) {
      unregisterConnection("party", userId, client);
      this.core.setConnected(userId, true);
      this.clearClientTracking(client.sessionId);
      this.syncState(true);
      return;
    }
    if (consented) {
      unregisterConnection("party", userId, client);
      this.clearClientTracking(client.sessionId);
      this.clearUserInput(userId);
      this.core.setConnected(userId, false);
      if (this.shutdownIfNoConnectedHumans(client)) return;
      this.core.takeOverPlayerWithAi(userId);
      this.syncState(true);
      return;
    }
    this.core.setConnected(userId, false);
    this.syncState();
    try {
      const reconnected = await this.allowReconnection(client, 60);
      reconnected.userData = { userId };
      const activeReplacement = this.findActiveClient(userId, reconnected);
      if (activeReplacement || hasRegisteredConnection("party", userId, client)) {
        reconnected.leave(4009, "DUPLICATE_LOGIN");
        this.clearClientTracking(reconnected.sessionId);
        this.core.setConnected(userId, true);
        unregisterConnection("party", userId, client);
        this.syncState();
        return;
      }
      registerConnection("party", userId, reconnected);
      unregisterConnection("party", userId, client);
      this.activeHumanSessions.add(reconnected.sessionId);
      this.core.setConnected(userId, true);
      this.initializeClientView(reconnected, userId);
      for (const init of this.exploration.allInit()) reconnected.send("minimap.init", init);
      this.sendFastLaneOffer(reconnected, userId);
    } catch {
      unregisterConnection("party", userId, client);
      const active = this.hasActiveClient(userId, client);
      if (active) this.core.setConnected(userId, true);
      else this.core.setConnected(userId, false);
      this.clearClientTracking(client.sessionId);
      if (!active && this.shutdownIfNoConnectedHumans(client)) return;
      if (!active) this.core.takeOverPlayerWithAi(userId);
    }
    this.syncState(true);
  }

  async onDispose(): Promise<void> {
    this.activeHumanSessions.clear();
    unregisterFastLaneRoom(this.roomId);
    removeRoomInvaderMetrics(this.roomId);
    if (!this.core || this.finalized) return;
    if (!this.core.result) this.core.finish("abandoned", "모든 용사가 원정을 떠났습니다.");
    try {
      await this.ensureResultPersisted();
    } catch (error) {
      console.error("Failed to persist match during room disposal", error);
    }
  }

  private handleCommand(client: Client, expectedType: ClientCommand["type"], raw: unknown): void {
    if (expectedType === "player.input") {
      const parsedInput = playerInputSchema.safeParse(raw);
      if (!parsedInput.success) {
        this.reject(client, "INVALID_MESSAGE");
        return;
      }
      this.applyInputFrame(client, {
        v: parsedInput.data.v,
        seq: parsedInput.data.seq,
        clientTime: parsedInput.data.clientTime,
        ...parsedInput.data.payload,
      });
      return;
    }
    if (!this.allowMessage(client.sessionId)) {
      client.send("protocol-error", { code: "RATE_LIMITED" });
      recordProtocolViolation(client, "RATE_LIMITED");
      return;
    }
    const parsed = clientCommandSchema.safeParse(raw);
    if (!parsed.success || parsed.data.type !== expectedType || JSON.stringify(raw).length > 4096) {
      client.send("protocol-error", { code: "INVALID_MESSAGE" });
      recordProtocolViolation(client, "INVALID_MESSAGE");
      return;
    }
    const userId = client.userData?.userId as string;
    const command = parsed.data as ClientCommand;
    const lastSequence = this.reliableCommandSequences.get(client.sessionId) ?? -1;
    if (command.seq <= lastSequence) {
      this.reject(client, "STALE_SEQUENCE");
      recordProtocolViolation(client, "STALE_SEQUENCE");
      return;
    }
    this.reliableCommandSequences.set(client.sessionId, command.seq);
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
      const aim = Math.atan2(command.payload.targetY - 360, command.payload.targetX - 640);
      if (!this.core.castSkill(userId, command.payload.skillId, aim)) this.reject(client, "SKILL_NOT_READY");
      return;
    }
    if (command.type === "build.place" || command.type === "build.upgrade") {
      this.reject(client, "BUILD_NOT_READY");
    }
  }

  private handleInputFrame(client: Client, raw: unknown, channel: "webtransport" | "websocket" = "websocket"): void {
    if (!this.allowInputMessage(client.sessionId)) return;
    const parsed = inputFrameSchema.safeParse(raw);
    if (!parsed.success) return;
    recordRealtimeInput(channel);
    this.applyInputFrame(client, parsed.data);
  }

  private applyInputFrame(client: Client, frame: InputFrame): void {
    const userId = client.userData?.userId as string | undefined;
    if (!userId) return;
    const lastSequence = this.inputSequences.get(userId) ?? -1;
    if (frame.seq <= lastSequence) return;
    const accepted = this.core.applyInput(userId, {
      v: frame.v,
      type: "player.input",
      seq: frame.seq,
      clientTime: frame.clientTime,
      payload: { x: frame.x, y: frame.y, aim: frame.aim, buttons: frame.buttons },
    });
    if (!accepted) return;
    this.inputSequences.set(userId, frame.seq);
    this.lastInputAt.set(userId, Date.now());
  }

  private simulate(deltaMs: number): void {
    const safeDeltaMs = Number.isFinite(deltaMs) ? Math.max(deltaMs, 0) : 0;
    this.simulationAccumulatorMs += safeDeltaMs;
    const pendingTicks = Math.floor(this.simulationAccumulatorMs / SIMULATION_STEP_MS + 1e-9);
    const simulationTicksToRun = Math.min(pendingTicks, MAX_CATCH_UP_TICKS);
    const skippedTicks = Math.max(0, pendingTicks - MAX_CATCH_UP_TICKS);
    const droppedCatchUp = skippedTicks > 0;
    if (droppedCatchUp) {
      const skippedSimulationMs = skippedTicks * SIMULATION_STEP_MS;
      this.core.compensateSkippedCombatTime(skippedSimulationMs / 1000);
      this.simulationAccumulatorMs = Math.max(0, this.simulationAccumulatorMs - skippedSimulationMs);
    }
    let simulatedTicks = 0;
    const inputLeaseCheckAt = Date.now();
    while (simulatedTicks < simulationTicksToRun) {
      this.expireStaleInputs(inputLeaseCheckAt);
      const coreStartedAt = performance.now();
      this.core.update(SIMULATION_STEP_MS / 1000);
      recordRealtimeTiming("coreUpdate", performance.now() - coreStartedAt);
      this.simulationAccumulatorMs -= SIMULATION_STEP_MS;
      this.serverTick += 1;
      simulatedTicks += 1;
    }
    this.simulationAccumulatorMs = Math.max(0, this.simulationAccumulatorMs);
    for (const notice of this.core.takeNotices()) {
      for (const client of this.clients) {
        if (client.userData?.userId === notice.userId) client.send("message", { code: notice.code, message: notice.message });
      }
    }
    recordSimulationCatchUp(simulatedTicks - 1, droppedCatchUp);
    this.schemaSyncAccumulatorMs += safeDeltaMs;
    this.explorationAccumulatorMs += safeDeltaMs;
    if (this.explorationAccumulatorMs >= MINIMAP_GEOMETRY_REFRESH_MS) {
      this.explorationAccumulatorMs %= MINIMAP_GEOMETRY_REFRESH_MS;
      this.exploration.update();
      for (const init of this.exploration.takeGeometryUpdates()) this.broadcast("minimap.init", init);
    }
    if (Date.now() - this.createdAt >= 35 * 60 * 1000 && this.core.phase !== "ended") {
      this.core.finish("abandoned", "원정 최대 진행 시간 35분을 초과했습니다.");
    }
    if (!this.gameplayLocked && this.core.phase !== "lobby") {
      this.gameplayLocked = true;
      this.lock();
    }
    const schemaSyncDue = this.schemaSyncAccumulatorMs >= SCHEMA_SYNC_INTERVAL_MS || this.core.phase === "ended";
    if (schemaSyncDue) {
      this.schemaSyncAccumulatorMs %= SCHEMA_SYNC_INTERVAL_MS;
      const schemaStartedAt = performance.now();
      this.syncState();
      recordRealtimeTiming("schemaSync", performance.now() - schemaStartedAt);
      const aoiStartedAt = performance.now();
      this.updateClientViews();
      recordRealtimeTiming("aoiUpdate", performance.now() - aoiStartedAt);
      const tiers = this.core.invaderSimulationTiers;
      recordRoomInvaderMetrics(this.roomId, {
        active: this.core.liveInvaderCount,
        pending: this.core.pendingInvaderCount,
        capHits: this.core.invaderCapHitCount,
        retired: this.core.retiredInvaderCount,
        hot: tiers.hot,
        warm: tiers.warm,
        cold: tiers.cold,
        multirateEnabled: this.multirateEnabled,
      });
    }
    if (simulatedTicks > 0 && this.serverTick % WORLD_FRAME_INTERVAL_TICKS === 0) {
      const frameStartedAt = performance.now();
      this.emitWorldFrames();
      recordRealtimeTiming("worldFrame", performance.now() - frameStartedAt);
    }
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

  private syncState(forceKeyframe = false): void {
    const now = Date.now();
    const keyframeDue = forceKeyframe || now - this.lastKeyframeAt >= KEYFRAME_INTERVAL_MS;
    const view = createCoreViewSnapshot(this.core);
    this.state.phase = view.phase;
    this.state.resultState = view.result ?? "";
    this.state.resultReason = view.resultReason;
    this.state.day = view.day;
    this.state.serverTime = Date.now();
    this.state.elapsed = view.elapsed;
    this.state.phaseEndsAt = view.phaseRemaining > 0 ? Date.now() + view.phaseRemaining * 1000 : 0;
    this.state.baseHp = view.baseHp;
    this.state.baseMaxHp = view.baseMaxHp;
    this.state.gold = view.gold;
    this.state.currentZone = view.currentZone;
    this.state.teamLevel = view.teamLevel;
    this.state.teamXp = view.teamXp;
    this.state.teamXpToNext = view.teamXpToNext;
    for (const player of view.players) {
      let state = this.state.players.get(player.userId);
      const isNew = !state;
      if (!state) {
        state = new PlayerState();
        this.state.players.set(player.userId, state);
      }
      const roomChanged = this.schemaRoomIds.get(player.userId) !== player.roomId;
      const combatStats = this.core.combatStats(player.userId);
      Object.assign(state, {
        userId: player.userId,
        displayName: player.displayName,
        heroClass: player.heroClass,
        roomId: player.roomId,
        hp: player.hp,
        maxHp: player.maxHp,
        level: player.level,
        teamPower: player.teamPower,
        attackDamage: combatStats?.attackDamage ?? 0,
        defense: combatStats?.defense ?? 0,
        criticalChance: combatStats?.criticalChance ?? 0,
        criticalDamage: combatStats?.criticalDamage ?? 150,
        attacksPerSecond: combatStats?.attacksPerSecond ?? 0,
        attackRange: combatStats?.attackRange ?? 0,
        moveSpeed: combatStats?.moveSpeed ?? 0,
        qCooldown: player.qCooldown,
        eCooldown: player.eCooldown,
        skillSequence: player.skillSequence,
        lastSkillId: player.lastSkillId ?? "",
        skillTargetX: player.skillTargetX,
        skillTargetY: player.skillTargetY,
        skillRadius: player.skillRadius,
        damage: player.damage,
        bossDamage: player.bossDamage,
        kills: player.kills,
        deaths: player.deaths,
        structuresBuilt: player.structuresBuilt,
        goldSpent: player.goldSpent,
        gatesDestroyed: player.gatesDestroyed,
        attackSequence: player.attackCount,
        attackTargetId: player.lastAttackTargetId ?? "",
        alive: player.alive,
        ready: player.ready,
        connected: player.connected,
      });
      if (isNew || keyframeDue || roomChanged) {
        state.x = player.x;
        state.y = player.y;
        state.aim = player.aim;
      }
      this.schemaRoomIds.set(player.userId, player.roomId);
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

    for (const room of view.rooms) {
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

    for (const door of view.doors) {
      let state = this.state.doors.get(door.id);
      if (!state) {
        state = new DoorState();
        this.state.doors.set(door.id, state);
      }
      Object.assign(state, door);
    }

    const liveEnemyIds = new Set(view.enemies.map((enemy) => enemy.id));
    this.state.enemies.forEach((state, id) => {
      if (liveEnemyIds.has(id)) return;
      for (const client of this.clients) {
        if (this.visibleEnemies.get(client.sessionId)?.delete(id)) client.view?.remove(state);
      }
      this.state.enemies.delete(id);
      this.schemaRoomIds.delete(`enemy:${id}`);
      this.previousTransforms.delete(`enemy:${id}`);
      this.lastEnemyFramePositions?.delete(id);
      this.enemySchemaSnapshots?.delete(id);
    });

    for (const enemy of view.enemies) {
      let state = this.state.enemies.get(enemy.id);
      const isNew = !state;
      if (!state) {
        state = new EnemyState();
        this.state.enemies.set(enemy.id, state);
      }
      const roomChanged = this.schemaRoomIds.get(`enemy:${enemy.id}`) !== enemy.roomId;
      const nextSnapshot: EnemySchemaSnapshot = {
        hp: enemy.hp,
        targetId: enemy.targetId ?? "",
        roomId: enemy.roomId,
        alive: enemy.alive,
        patternKind: enemy.patternKind,
        patternPhase: enemy.patternPhase,
        patternRemaining: enemy.patternRemaining,
        patternIndex: enemy.patternIndex,
        attackSequence: enemy.attackSequence,
      };
      this.enemySchemaSnapshots ??= new Map<string, EnemySchemaSnapshot>();
      const previousSnapshot = this.enemySchemaSnapshots.get(enemy.id);
      const revisionChanged = !previousSnapshot
        || previousSnapshot.hp !== nextSnapshot.hp
        || previousSnapshot.targetId !== nextSnapshot.targetId
        || previousSnapshot.roomId !== nextSnapshot.roomId
        || previousSnapshot.alive !== nextSnapshot.alive
        || previousSnapshot.patternKind !== nextSnapshot.patternKind
        || previousSnapshot.patternPhase !== nextSnapshot.patternPhase
        || previousSnapshot.patternRemaining !== nextSnapshot.patternRemaining
        || previousSnapshot.patternIndex !== nextSnapshot.patternIndex
        || previousSnapshot.attackSequence !== nextSnapshot.attackSequence;
      if (isNew || revisionChanged) {
        Object.assign(state, {
          id: enemy.id,
          kind: enemy.kind,
          behavior: enemy.behavior,
          spawnRoomId: enemy.spawnRoomId,
          maxHp: enemy.maxHp,
          ...nextSnapshot,
        });
        this.enemySchemaSnapshots.set(enemy.id, nextSnapshot);
      }
      if (isNew || keyframeDue || roomChanged) {
        state.x = enemy.x;
        state.y = enemy.y;
      }
      this.schemaRoomIds.set(`enemy:${enemy.id}`, enemy.roomId);
    }
    this.refreshEnemyRoomBuckets(view.enemies);

    for (const waypoint of view.waypoints) {
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
    for (const drop of view.drops) {
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
    if (keyframeDue) this.lastKeyframeAt = now;
  }

  private expireStaleInputs(now: number): void {
    for (const player of this.core.players.values()) {
      const receivedAt = this.lastInputAt.get(player.userId) ?? 0;
      if (now - receivedAt <= INPUT_LEASE_MS) continue;
      if (player.inputX !== 0 || player.inputY !== 0) recordInputLeaseExpiration();
      player.inputX = 0;
      player.inputY = 0;
    }
  }

  private emitWorldFrames(): void {
    const serverTime = Date.now();
    const enemyKeyframe = this.serverTick % ENEMY_WORLD_KEYFRAME_TICKS === 0;
    const playerSamples = new Map<string, TransformSample>();
    const enemySamples = new Map<string, TransformSample>();
    for (const player of this.core.players.values()) {
      playerSamples.set(player.userId, this.transformSample(
        `player:${player.userId}`,
        player.userId,
        player.roomId,
        player.x,
        player.y,
        player.aim,
        serverTime,
      ));
    }
    for (const enemy of this.core.enemies.values()) {
      if (!this.core.discoveredRooms.has(enemy.roomId)) continue;
      const previous = this.lastEnemyFramePositions.get(enemy.id);
      const changed = !previous || previous.revision !== enemy.transformRevision
        || previous.roomId !== enemy.roomId || previous.x !== enemy.x || previous.y !== enemy.y;
      if (!enemyKeyframe && !changed) continue;
      enemySamples.set(enemy.id, this.transformSample(
        `enemy:${enemy.id}`,
        enemy.id,
        enemy.roomId,
        enemy.x,
        enemy.y,
        0,
        serverTime,
      ));
      this.lastEnemyFramePositions.set(enemy.id, {
        roomId: enemy.roomId,
        x: enemy.x,
        y: enemy.y,
        revision: enemy.transformRevision,
      });
    }
    for (const client of this.clients) {
      const userId = client.userData?.userId as string | undefined;
      const viewer = userId ? this.core.players.get(userId) : undefined;
      if (!userId || !viewer) continue;
      const frame: WorldFrame = {
        v: PROTOCOL_VERSION,
        serverTick: this.serverTick,
        serverTime,
        ackInputSeq: this.inputSequences.get(userId) ?? -1,
        players: [...this.core.players.values()]
          .filter((player) => player.userId === userId || this.isPlayerInAoi(viewer, player))
          .map((player) => playerSamples.get(player.userId) as TransformSample),
        enemies: [...enemySamples.values()].filter((enemy) => this.aoiRooms(viewer.roomId).has(enemy.roomId)),
      };
      const fastLaneBytes = sendFastLaneWorldFrame(client.sessionId, frame);
      if (fastLaneBytes !== null) {
        recordRealtimeWorldFrame("webtransport", fastLaneBytes);
      } else {
        client.send("world.frame", frame);
        this.websocketSizeSamples += 1;
        if (this.websocketSizeSamples % WEBSOCKET_SIZE_SAMPLE_INTERVAL === 1 || this.lastWebsocketFrameBytes === 0) {
          this.lastWebsocketFrameBytes = Buffer.byteLength(JSON.stringify(frame));
        }
        recordRealtimeWorldFrame("websocket", this.lastWebsocketFrameBytes);
      }
    }
  }

  private transformSample(
    cacheKey: string,
    id: string,
    roomId: string,
    x: number,
    y: number,
    aim: number,
    serverTime: number,
  ): TransformSample {
    const previous = this.previousTransforms.get(cacheKey);
    const deltaSeconds = previous ? Math.max(0.001, (serverTime - previous.at) / 1000) : 0;
    const distance = previous ? Math.hypot(x - previous.x, y - previous.y) : 0;
    const discontinuity = Boolean(previous && distance > DISCONTINUITY_DISTANCE);
    const moved = !previous || previous.roomId !== roomId || distance > 0;
    const vx = previous && !discontinuity && distance > 0 ? (x - previous.x) / deltaSeconds : (previous?.vx ?? 0);
    const vy = previous && !discontinuity && distance > 0 ? (y - previous.y) / deltaSeconds : (previous?.vy ?? 0);
    const sample: TransformSample = {
      id,
      roomId,
      x,
      y,
      vx: discontinuity ? 0 : vx,
      vy: discontinuity ? 0 : vy,
      aim,
      flags: discontinuity ? transformFlags.discontinuity : transformFlags.none,
    };
    if (moved) this.previousTransforms.set(cacheKey, {
      roomId,
      x,
      y,
      at: serverTime,
      vx: sample.vx,
      vy: sample.vy,
    });
    return sample;
  }

  private isPlayerInAoi(
    viewer: { roomId: string; x: number; y: number },
    candidate: { roomId: string; x: number; y: number },
  ): boolean {
    return this.aoiRooms(viewer.roomId).has(candidate.roomId);
  }

  private aoiRooms(roomId: string): ReadonlySet<string> {
    this.aoiRoomCache ??= new Map<string, ReadonlySet<string>>();
    const authoredWorld = Boolean(this.core.options?.world);
    const cacheKey = `${authoredWorld ? "authored" : "procedural"}:${roomId}`;
    const cached = this.aoiRoomCache.get(cacheKey);
    if (cached) return cached;
    const viewerRoom = this.core.rooms.get(roomId as CoreRoomId);
    if (!viewerRoom) return new Set();
    if (!authoredWorld && roomId === BOSS_ROOM_ID) {
      const bossOnly = new Set([roomId]);
      this.aoiRoomCache.set(cacheKey, bossOnly);
      return bossOnly;
    }
    const visited = new Set<string>([roomId]);
    let frontier = [roomId];
    for (let depth = 0; depth < 2; depth += 1) {
      const next: string[] = [];
      for (const frontierRoomId of frontier) {
        for (const connectedId of this.core.rooms.get(frontierRoomId as CoreRoomId)?.connections ?? []) {
          if (visited.has(connectedId)) continue;
          const connectedRoom = this.core.rooms.get(connectedId as CoreRoomId);
          if (!connectedRoom) continue;
          if (!authoredWorld && (connectedRoom.zone !== viewerRoom.zone || connectedId === BOSS_ROOM_ID)) continue;
          visited.add(connectedId);
          next.push(connectedId);
        }
      }
      frontier = next;
    }
    this.aoiRoomCache.set(cacheKey, visited);
    return visited;
  }

  private updateClientViews(): void {
    for (const client of this.clients) {
      const userId = client.userData?.userId as string | undefined;
      if (userId) this.updateClientView(client, userId);
    }
  }

  private refreshEnemyRoomBuckets(enemies: Iterable<{ id: string; roomId: string }>): void {
    this.enemyIdsByRoom ??= new Map<string, Set<string>>();
    this.enemyRoomMembership ??= new Map<string, string>();
    this.enemyMembershipRevision ??= 0;
    const liveIds = new Set<string>();
    let changed = false;
    for (const enemy of enemies) {
      liveIds.add(enemy.id);
      const previousRoomId = this.enemyRoomMembership.get(enemy.id);
      if (previousRoomId === enemy.roomId) continue;
      if (previousRoomId) this.enemyIdsByRoom.get(previousRoomId)?.delete(enemy.id);
      let bucket = this.enemyIdsByRoom.get(enemy.roomId);
      if (!bucket) {
        bucket = new Set<string>();
        this.enemyIdsByRoom.set(enemy.roomId, bucket);
      }
      bucket.add(enemy.id);
      this.enemyRoomMembership.set(enemy.id, enemy.roomId);
      changed = true;
    }
    for (const [enemyId, roomId] of this.enemyRoomMembership) {
      if (liveIds.has(enemyId)) continue;
      this.enemyRoomMembership.delete(enemyId);
      this.enemyIdsByRoom.get(roomId)?.delete(enemyId);
      changed = true;
    }
    if (changed) this.enemyMembershipRevision += 1;
  }

  private updateClientView(client: Client, userId: string): void {
    const viewer = this.core.players.get(userId);
    if (!viewer || !client.view) return;
    const playerIds = this.visiblePlayerTransforms.get(client.sessionId) ?? new Set<string>();
    const nextPlayerIds = partyPlayerIdsForView(this.core.players.values());
    for (const player of this.core.players.values()) {
      const state = this.state.players.get(player.userId);
      if (!state) continue;
      if (!playerIds.has(player.userId)) client.view.add(state, PLAYER_TRANSFORM_VIEW);
    }
    for (const id of playerIds) {
      if (nextPlayerIds.has(id)) continue;
      const state = this.state.players.get(id);
      if (state) client.view.remove(state, PLAYER_TRANSFORM_VIEW);
    }
    this.visiblePlayerTransforms.set(client.sessionId, nextPlayerIds);

    const enemyIds = this.visibleEnemies.get(client.sessionId) ?? new Set<string>();
    const enemyViewState = this.clientEnemyViewRevision.get(client.sessionId);
    if (!enemyViewState || enemyViewState.viewerRoomId !== viewer.roomId || enemyViewState.revision !== this.enemyMembershipRevision) {
      const nextEnemyIds = new Set<string>();
      for (const roomId of this.aoiRooms(viewer.roomId)) {
        for (const enemyId of this.enemyIdsByRoom.get(roomId) ?? []) {
          const state = this.state.enemies.get(enemyId);
          if (!state) continue;
          nextEnemyIds.add(enemyId);
          if (!enemyIds.has(enemyId)) client.view.add(state);
        }
      }
      for (const id of enemyIds) {
        if (!nextEnemyIds.has(id)) {
          const state = this.state.enemies.get(id);
          if (state) client.view.remove(state);
        }
      }
      this.visibleEnemies.set(client.sessionId, nextEnemyIds);
      this.clientEnemyViewRevision.set(client.sessionId, {
        viewerRoomId: viewer.roomId,
        revision: this.enemyMembershipRevision,
      });
    }

    const dropIds = this.visibleDrops.get(client.sessionId) ?? new Set<string>();
    const nextDropIds = new Set<string>();
    this.state.drops.forEach((drop) => {
      if (drop.ownerUserId !== userId || drop.roomId !== viewer.roomId) return;
      nextDropIds.add(drop.id);
      if (!dropIds.has(drop.id)) client.view?.add(drop);
    });
    for (const id of dropIds) {
      if (!nextDropIds.has(id)) {
        const state = this.state.drops.get(id);
        if (state) client.view.remove(state);
      }
    }
    this.visibleDrops.set(client.sessionId, nextDropIds);
  }

  private sendFastLaneOffer(client: Client, userId: string): void {
    const offer = issueFastLaneOffer(this.roomId, client.sessionId, userId);
    if (offer) client.send("fastlane.offer", offer);
  }

  private reject(client: Client, code: string): void {
    client.send("protocol-error", { code });
  }

  private hasActiveClient(userId: string, excluded: Client): boolean {
    return Boolean(this.findActiveClient(userId, excluded));
  }

  private shutdownIfNoConnectedHumans(excluded?: Client): boolean {
    if (this.shutdownStarted) return true;
    if (excluded) this.activeHumanSessions.delete(excluded.sessionId);
    if (this.activeHumanSessions.size > 0) return false;

    this.shutdownStarted = true;
    if (this.core.phase !== "ended") this.core.finish("abandoned", "모든 용사가 원정을 떠났습니다.");
    this.syncState(true);
    void this.finalizeAndDisconnect();
    return true;
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
    if (player) view.add(player, PLAYER_TRANSFORM_VIEW);
    this.visiblePlayerTransforms.set(client.sessionId, new Set(player ? [userId] : []));
    this.visibleEnemies.set(client.sessionId, new Set());
    this.visibleDrops.set(client.sessionId, new Set());
    this.updateClientView(client, userId);
  }

  private addPrivateStateToOwner(userId: string, state: DropState): void {
    for (const client of this.clients) {
      const viewer = this.core.players.get(userId);
      if (client.userData?.userId === userId && viewer?.roomId === state.roomId) client.view?.add(state);
    }
  }

  private clearClientTracking(sessionId: string): void {
    unbindFastLaneSession(sessionId);
    this.messageWindows.delete(sessionId);
    this.inputMessageWindows.delete(sessionId);
    this.reliableCommandSequences.delete(sessionId);
    this.visibleEnemies.delete(sessionId);
    this.visibleDrops.delete(sessionId);
    this.visiblePlayerTransforms.delete(sessionId);
    this.clientEnemyViewRevision?.delete(sessionId);
  }

  private clearUserInput(userId: string): void {
    this.inputSequences.delete(userId);
    this.lastInputAt.delete(userId);
    const player = this.core.players.get(userId);
    if (player) {
      player.inputX = 0;
      player.inputY = 0;
    }
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

  private allowInputMessage(sessionId: string): boolean {
    const now = Date.now();
    const window = this.inputMessageWindows.get(sessionId);
    if (!window || now - window.startedAt >= 1000) {
      this.inputMessageWindows.set(sessionId, { startedAt: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= 90;
  }
}

export function consumeGameTicket(
  claims: Pick<GameTicketClaims, "jti" | "sub" | "room">,
  consume: typeof consumeGameTicketNonce = consumeGameTicketNonce,
): Promise<boolean> {
  return consume({ jti: claims.jti, userId: claims.sub, room: claims.room });
}

export { PARTY_ROOM };
