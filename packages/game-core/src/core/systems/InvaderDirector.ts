import { createSeededRandom, hashSeed } from "../../v02/random";
import {
  createInvaderEnemy,
  doorId,
  type CoreEnemy,
  type CoreRoomId,
} from "../../v02/simulation";
import { corridorRectBetween, resolveWalkableDiscPointIndexed, resolveWalkablePoint, roomContainingPoint } from "../../v02/world";
import type { GameCore } from "../GameCore";
import type { CorePlayer, GameCoreOptions, InvaderNavigation, InvaderSimulationTiers, InvaderWaveBatch } from "../types";
import {
  ABSOLUTE_MAX_LIVE_INVADERS,
  ACTOR_COLLISION_RADIUS,
  DEFAULT_MAX_LIVE_INVADERS,
  INVADER_AGGRO_RADIUS,
  INVADER_BASE_RADIUS,
  INVADER_BLOCKED_EDGE_SECONDS,
  INVADER_COMBAT_RADIUS,
  INVADER_CORRIDOR_LANE_OFFSET,
  INVADER_DAY_WAVES,
  INVADER_EMERGENCE_HOLD_TICKS,
  INVADER_INITIAL_SPAWN_DELAY_SECONDS,
  INVADER_MICRO_SPAWN_COUNT,
  INVADER_MICRO_SPAWN_INTERVAL_SECONDS,
  INVADER_NIGHT_WAVES,
  INVADER_RELEASE_RADIUS,
  INVADER_REPLAN_BUDGET_PER_TICK,
  INVADER_RETRY_SECONDS,
  INVADER_SPAWN_SLOTS,
  INVADER_SPAWN_GROUP_PAUSE_SECONDS,
  INVADER_SPAWN_GROUP_SIZE,
  INVADER_STALL_DISTANCE,
  INVADER_STALL_SECONDS,
  MAX_PENDING_INVADERS,
  SIMULATION_EPSILON,
  durations,
} from "../constants";
import { clamp, clampUpdateRate, invaderEdgeKey } from "../helpers";
import type { ZoneId } from "../../v02/map";
import { waveBatchSize } from "../../v02/balance";

type ReplanPriority = 0 | 1 | 2;
type PendingInvaderReplan = { allowRandom: boolean; priority: ReplanPriority };

/**
 * Owns every gate-invader concern: wave queues, per-enemy navigation state,
 * tiered (hot/warm/cold) LOD simulation, and O(1) population counters.
 * Mutates shared world state through the owning {@link GameCore}.
 */
export class InvaderDirector {
  readonly maxLiveInvaders: number;
  private readonly warmInvaderDivisor: number;
  private readonly coldInvaderDivisor: number;
  private readonly warmDecisionDivisor: number;
  private readonly coldDecisionDivisor: number;
  private readonly simulationWheel = Array.from({ length: 60 }, () => new Set<string>());
  private readonly nextSimulationTick = new Map<string, number>();
  private readonly invaderTiers = new Map<string, "hot" | "warm" | "cold">();
  private readonly invaderNavigation = new Map<string, InvaderNavigation>();
  private readonly invaderWaveQueue: InvaderWaveBatch[] = [];
  private readonly routeCache = new Map<string, readonly CoreRoomId[]>();
  private readonly playerTargetScratch = new Map<string, CorePlayer>();
  private readonly playerRoomsScratch = new Set<CoreRoomId>();
  private readonly playerZoneScratch: Array<{ player: CorePlayer; zone: ZoneId | undefined }> = [];
  private invaderSpawnAccumulator = 0;
  private invaderSpawnReleaseAccumulator = 0;
  private invaderWaveIndex = 0;
  private releasedInSpawnGroup = 0;
  private initialSpawnDelayCompleted = false;
  private invaderSerial = 0;
  private retiredInvaders = 0;
  private invaderCapHits = 0;
  private microSpawnedInvaders = 0;
  private completedInvaderReplans = 0;
  private liveInvaders = 0;
  private pendingInvaders = 0;
  private invaderSimulationTick = 0;
  private simulationElapsed = 0;
  private invaderTierCounts: InvaderSimulationTiers = { hot: 0, warm: 0, cold: 0 };
  private warmRoomCache: { key: string; rooms: ReadonlySet<CoreRoomId> } | null = null;
  private readonly pendingInvaderReplans = new Map<string, PendingInvaderReplan>();
  private readonly pendingReplanQueues: [string[], string[], string[]] = [[], [], []];
  private readonly pendingReplanHeads: [number, number, number] = [0, 0, 0];
  private readonly pendingReplanQueuedAt = new Map<string, number>();
  private hotExecutions = 0;
  private warmExecutions = 0;
  private coldExecutions = 0;
  private scheduleDelayTicks = 0;
  private schedulerEnabled = true;

  constructor(
    private readonly core: GameCore,
    options: GameCoreOptions,
  ) {
    const requestedInvaderLimit = options.maxLiveInvaders ?? DEFAULT_MAX_LIVE_INVADERS;
    this.maxLiveInvaders = Number.isFinite(requestedInvaderLimit)
      ? Math.max(1, Math.min(ABSOLUTE_MAX_LIVE_INVADERS, Math.floor(requestedInvaderLimit)))
      : DEFAULT_MAX_LIVE_INVADERS;
    const warmHz = clampUpdateRate(options.invaderUpdateRates?.warmMovementHz ?? options.invaderUpdateRates?.warmHz ?? 60);
    const coldHz = clampUpdateRate(options.invaderUpdateRates?.coldMovementHz ?? options.invaderUpdateRates?.coldHz ?? 60);
    this.warmInvaderDivisor = Math.max(1, Math.round(60 / warmHz));
    this.coldInvaderDivisor = Math.max(this.warmInvaderDivisor, Math.round(60 / coldHz));
    this.warmDecisionDivisor = Math.max(1, Math.round(60 / clampUpdateRate(options.invaderUpdateRates?.warmHz ?? 60)));
    this.coldDecisionDivisor = Math.max(this.warmDecisionDivisor, Math.round(60 / clampUpdateRate(options.invaderUpdateRates?.coldHz ?? 60)));
  }

  get liveCount(): number {
    return this.liveInvaders;
  }

  get pendingCount(): number {
    return this.pendingInvaders;
  }

  get retiredCount(): number {
    return this.retiredInvaders;
  }

  get capHitCount(): number {
    return this.invaderCapHits;
  }

  get simulationTiers(): InvaderSimulationTiers {
    return { ...this.invaderTierCounts };
  }

  setSchedulerEnabled(enabled: boolean): void {
    if (this.schedulerEnabled === enabled) return;
    this.schedulerEnabled = enabled;
    if (!enabled) {
      for (const enemyId of this.invaderNavigation.keys()) this.scheduleSimulation(enemyId, this.invaderSimulationTick + 1);
    }
  }

  /** @internal current spawn serial, used by the core for deterministic gate selection. */
  get currentSpawnSerial(): number {
    return this.invaderSerial;
  }

  /** @internal work accounting consumed by server metrics and white-box tests. */
  get workMetrics(): Readonly<{
    microSpawned: number;
    pendingReplans: number;
    completedReplans: number;
    oldestPendingWaveSeconds: number;
    hotExecutions: number;
    warmExecutions: number;
    coldExecutions: number;
    scheduleDelayTicks: number;
    movementBacklogSeconds: number;
    oldestPendingReplanSeconds: number;
  }> {
    let movementBacklogSeconds = 0;
    for (const navigation of this.invaderNavigation.values()) {
      movementBacklogSeconds += navigation.accumulatedDelta;
    }
    let oldestPendingReplanSeconds = 0;
    for (const enemyId of this.pendingInvaderReplans.keys()) {
      oldestPendingReplanSeconds = Math.max(
        oldestPendingReplanSeconds,
        this.core.elapsed - (this.pendingReplanQueuedAt.get(enemyId) ?? this.core.elapsed),
      );
    }
    return {
      microSpawned: this.microSpawnedInvaders,
      pendingReplans: this.pendingInvaderReplans.size,
      completedReplans: this.completedInvaderReplans,
      oldestPendingWaveSeconds: Math.max(0, this.core.elapsed - (this.invaderWaveQueue[0]?.queuedAt ?? this.core.elapsed)),
      hotExecutions: this.hotExecutions,
      warmExecutions: this.warmExecutions,
      coldExecutions: this.coldExecutions,
      scheduleDelayTicks: this.scheduleDelayTicks,
      movementBacklogSeconds,
      oldestPendingReplanSeconds,
    };
  }

  /** Resets wave progress when the phase changes. */
  resetWaveProgress(): void {
    this.invaderSpawnAccumulator = 0;
    this.invaderSpawnReleaseAccumulator = 0;
    this.invaderWaveIndex = 0;
    this.releasedInSpawnGroup = 0;
  }

  spawn(zone: ZoneId = this.core.currentZone, gateEnemyId?: string, deferReplan = false): CoreEnemy {
    if (this.liveInvaders >= this.maxLiveInvaders) {
      this.invaderCapHits += 1;
      throw new RangeError(`Live invader limit of ${this.maxLiveInvaders} reached`);
    }
    const spawnIndex = this.invaderSerial;
    const requestedGate = gateEnemyId ? this.core.enemies.get(gateEnemyId) : null;
    const explicitGate = requestedGate?.kind === "gate" && requestedGate.alive ? requestedGate : null;
    const authoredGate = this.core.authoredWorld ? explicitGate ?? this.core.authoredSpawnGate(zone) : null;
    const authoredPath = authoredGate
      ? this.core.shortestRoomPath(authoredGate.roomId, this.core.authoredWorld!.baseRoomId)
      : null;
    const authoredPosition = authoredGate ? this.core.roomWorldCenterOf(authoredGate.roomId) : null;
    const invader = createInvaderEnemy(
      this.core.options.seed,
      zone,
      this.invaderSerial,
      this.core.maps,
      this.core.options.difficulty,
      this.core.balancePartySize,
      authoredGate && authoredPath && authoredPosition
        ? { roomId: authoredGate.roomId, path: authoredPath, position: authoredPosition }
        : undefined,
    );
    const gate = authoredGate ?? explicitGate ?? this.core.livingGateInZone(zone);
    if (gate) {
      const spawn = this.invaderSpawnPosition(zone, gate, spawnIndex);
      invader.x = spawn.x;
      invader.y = spawn.y;
      invader.spawnX = spawn.x;
      invader.spawnY = spawn.y;
    }
    const targetPreference = this.core.phase === "night"
      ? spawnIndex % 4 === 0 ? "player" : "base"
      : spawnIndex % 2 === 0 ? "player" : "base";
    const navigation = this.createInvaderNavigation(invader, targetPreference);
    if (targetPreference === "player") {
      const nearbyPlayer = this.nearestInvaderPlayerTarget(invader);
      if (nearbyPlayer) {
        invader.targetId = nearbyPlayer.userId;
        navigation.targetRoomId = nearbyPlayer.roomId;
      }
    }
    this.invaderSerial += 1;
    this.liveInvaders += 1;
    this.core.enemies.set(invader.id, invader);
    this.invaderNavigation.set(invader.id, navigation);
    this.invaderTiers.set(invader.id, "cold");
    // Keep a fresh unit at its gate until its first snapshot and emergence
    // animation can reach clients. This prevents an already-moving unit from
    // first appearing several metres away from its authoritative spawn point.
    this.scheduleSimulation(
      invader.id,
      this.invaderSimulationTick + (deferReplan ? INVADER_EMERGENCE_HOLD_TICKS : 1),
    );
    if (deferReplan) this.scheduleInvaderReplan(invader.id, true);
    else this.replanInvader(invader, this.invaderNavigation.get(invader.id) as InvaderNavigation, true);
    return invader;
  }

  update(delta: number): void {
    this.simulationElapsed += Math.max(0, Math.min(0.1, delta));
    this.invaderSimulationTick += 1;
    if (this.invaderSimulationTick % 3 === 0) this.assignInvaderPlayerTargets(this.playerTargetScratch);
    if (this.invaderSimulationTick === 1 || this.invaderSimulationTick % 6 === 0 || delta >= 0.1 - SIMULATION_EPSILON) {
      this.refreshSimulationTiers(this.invaderSimulationTick % 3 !== 0);
    }
    const due = this.simulationWheel[this.invaderSimulationTick % this.simulationWheel.length]!;
    const dueIds = [...due];
    due.clear();
    const playerTargets = this.playerTargetScratch;
    const playerRooms = this.playerRoomsScratch;
    for (const enemyId of dueIds) {
      const scheduledTick = this.nextSimulationTick.get(enemyId);
      if (scheduledTick !== this.invaderSimulationTick) continue;
      this.nextSimulationTick.delete(enemyId);
      const enemy = this.core.enemies.get(enemyId);
      if (!enemy?.alive || enemy.behavior !== "invader") continue;
      const navigation = this.invaderNavigation.get(enemy.id) ?? this.createInvaderNavigation(enemy);
      this.invaderNavigation.set(enemy.id, navigation);
      this.scheduleDelayTicks += Math.max(0, this.invaderSimulationTick - scheduledTick);
      navigation.accumulatedDelta = Math.min(0.5, navigation.accumulatedDelta + Math.max(0, this.simulationElapsed - navigation.lastUpdateAt));
      navigation.lastUpdateAt = this.simulationElapsed;
      const stepDelta = Math.min(0.1, navigation.accumulatedDelta);
      navigation.accumulatedDelta = Math.max(0, navigation.accumulatedDelta - stepDelta);
      const playerTarget = playerTargets.get(enemy.id) ?? null;
      this.promoteToHotIfNeeded(enemy, playerTarget);
      const tier = this.invaderTiers.get(enemy.id) ?? "cold";
      const decisionDivisor = !this.schedulerEnabled || tier === "hot"
        ? 1 : tier === "warm" ? this.warmDecisionDivisor : this.coldDecisionDivisor;
      const decisionDue = tier === "hot" || this.invaderSimulationTick >= navigation.nextDecisionTick;
      if (decisionDue) navigation.nextDecisionTick = this.invaderSimulationTick + decisionDivisor;
      const activeTarget = decisionDue
        ? playerTarget
        : enemy.targetId && enemy.targetId !== "base" ? this.core.players.get(enemy.targetId) ?? null : null;
      if (tier === "hot") this.hotExecutions += 1;
      else if (tier === "warm") this.warmExecutions += 1;
      else this.coldExecutions += 1;
      this.processInvader(enemy, navigation, stepDelta, activeTarget, decisionDue);
      if (enemy.alive) {
        const divisor = !this.schedulerEnabled || tier === "hot" ? 1 : tier === "warm" ? this.warmInvaderDivisor : this.coldInvaderDivisor;
        this.scheduleSimulation(enemy.id, this.invaderSimulationTick + (navigation.accumulatedDelta > SIMULATION_EPSILON ? 1 : divisor));
      }
    }
    this.releasePendingInvaderReplans(playerTargets, playerRooms);
  }

  private refreshSimulationTiers(refreshTargets = true): void {
    if (refreshTargets) this.assignInvaderPlayerTargets(this.playerTargetScratch);
    this.collectPlayerRooms(this.playerRoomsScratch);
    const playerTargets = this.playerTargetScratch;
    const playerRooms = this.playerRoomsScratch;
    const warmRooms = this.invaderWarmRooms(playerRooms);
    let hotCount = 0;
    let warmCount = 0;
    let coldCount = 0;
    for (const enemy of this.core.enemies.values()) {
      if (!enemy.alive || enemy.behavior !== "invader") continue;
      const playerTarget = playerTargets.get(enemy.id) ?? null;
      const playerDistance = playerTarget && playerTarget.roomId === enemy.roomId
        ? Math.hypot(playerTarget.x - enemy.x, playerTarget.y - enemy.y)
        : Number.POSITIVE_INFINITY;
      const baseDestination = this.invaderBaseDestination(enemy);
      const baseCenter = enemy.roomId === baseDestination ? this.core.roomWorldCenterOf(baseDestination) : null;
      const baseDistance = baseCenter ? Math.hypot(baseCenter.x - enemy.x, baseCenter.y - enemy.y) : Number.POSITIVE_INFINITY;
      const hot = playerDistance <= Math.max(INVADER_COMBAT_RADIUS, enemy.attackRange + enemy.speed * 0.1)
        || baseDistance <= Math.max(INVADER_COMBAT_RADIUS, INVADER_BASE_RADIUS + enemy.speed * 0.1);
      const warm = !hot && (Boolean(playerTarget) || playerRooms.has(enemy.roomId) || warmRooms.has(enemy.roomId));
      if (hot) hotCount += 1;
      else if (warm) warmCount += 1;
      else coldCount += 1;
      const tier = hot ? "hot" : warm ? "warm" : "cold";
      if (this.invaderTiers.get(enemy.id) !== tier) {
        this.invaderTiers.set(enemy.id, tier);
        const divisor = !this.schedulerEnabled || tier === "hot" ? 1 : tier === "warm" ? this.warmInvaderDivisor : this.coldInvaderDivisor;
        const navigation = this.invaderNavigation.get(enemy.id) ?? this.createInvaderNavigation(enemy);
        this.invaderNavigation.set(enemy.id, navigation);
        this.scheduleSimulation(enemy.id, this.invaderSimulationTick + Math.max(1, Math.abs(navigation.cohort) % divisor));
      }
    }
    this.invaderTierCounts = { hot: hotCount, warm: warmCount, cold: coldCount };
  }

  private promoteToHotIfNeeded(enemy: CoreEnemy, playerTarget: CorePlayer | null): void {
    const currentTier = this.invaderTiers.get(enemy.id) ?? "cold";
    if (currentTier === "hot") return;
    const playerDistance = playerTarget?.roomId === enemy.roomId
      ? Math.hypot(playerTarget.x - enemy.x, playerTarget.y - enemy.y)
      : Number.POSITIVE_INFINITY;
    const baseDestination = this.invaderBaseDestination(enemy);
    const baseCenter = enemy.roomId === baseDestination ? this.core.roomWorldCenterOf(baseDestination) : null;
    const baseDistance = baseCenter ? Math.hypot(baseCenter.x - enemy.x, baseCenter.y - enemy.y) : Number.POSITIVE_INFINITY;
    if (playerDistance > Math.max(INVADER_COMBAT_RADIUS, enemy.attackRange + enemy.speed * 0.1)
      && baseDistance > Math.max(INVADER_COMBAT_RADIUS, INVADER_BASE_RADIUS + enemy.speed * 0.1)) return;
    this.invaderTiers.set(enemy.id, "hot");
    this.invaderTierCounts = {
      hot: this.invaderTierCounts.hot + 1,
      warm: this.invaderTierCounts.warm - (currentTier === "warm" ? 1 : 0),
      cold: this.invaderTierCounts.cold - (currentTier === "cold" ? 1 : 0),
    };
  }

  private processInvader(
    enemy: CoreEnemy,
    navigation: InvaderNavigation,
    stepDelta: number,
    playerTarget: CorePlayer | null,
    decisionDue: boolean,
  ): void {
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - stepDelta);
      navigation.retryRemaining = Math.max(0, navigation.retryRemaining - stepDelta);
      const targetId = playerTarget?.userId ?? "base";
      const targetRoomId = playerTarget?.roomId ?? this.invaderBaseDestination(enemy);
      if (decisionDue && (enemy.targetId !== targetId || navigation.targetRoomId !== targetRoomId)) {
        enemy.targetId = targetId;
        navigation.targetRoomId = targetRoomId;
        if (playerTarget?.roomId === enemy.roomId) {
          enemy.path = [enemy.roomId];
          enemy.pathIndex = 0;
          navigation.retryRemaining = 0;
          navigation.portalPassed = false;
          navigation.corridorWaypointIndex = 0;
          navigation.corridorConnectionId = null;
          this.cancelInvaderReplan(enemy.id);
          this.resetInvaderStall(enemy, navigation);
        } else {
          this.scheduleInvaderReplan(enemy.id, true);
          return;
        }
      }

      if (enemy.path[enemy.pathIndex] !== enemy.roomId && navigation.retryRemaining <= 0) {
        if (decisionDue) this.scheduleInvaderReplan(enemy.id, false);
        return;
      }

      if (playerTarget && playerTarget.roomId === enemy.roomId) {
        const distance = Math.hypot(playerTarget.x - enemy.x, playerTarget.y - enemy.y);
        if (distance <= enemy.attackRange) {
          this.resetInvaderStall(enemy, navigation);
          if (enemy.attackCooldown <= 0) {
            enemy.attackSequence += 1;
            enemy.attackCooldown = 1;
            this.core.recordEnemyCombatAction(enemy, playerTarget, "melee");
            this.core.damagePlayer(playerTarget, enemy.damage);
          }
        } else {
          this.moveInvaderWorld(enemy, navigation, playerTarget.x, playerTarget.y, stepDelta, null);
        }
        return;
      }

      if (enemy.pathIndex + 1 < enemy.path.length) {
        const nextRoomId = enemy.path[enemy.pathIndex + 1] as CoreRoomId;
        if (!this.isInvaderEdgeTraversable(enemy.roomId, nextRoomId, navigation)) {
          this.scheduleInvaderReplan(enemy.id, false);
          return;
        }
        this.moveInvaderThroughConnection(enemy, navigation, nextRoomId, stepDelta);
        return;
      }

      if (enemy.targetId === "base") {
        const baseTarget = this.core.roomWorldCenterOf(this.invaderBaseDestination(enemy));
        const distance = Math.hypot(baseTarget.x - enemy.x, baseTarget.y - enemy.y);
        if (distance > INVADER_BASE_RADIUS) {
          this.moveInvaderWorld(enemy, navigation, baseTarget.x, baseTarget.y, stepDelta, null);
        } else {
          this.core.damageBase(enemy.damage);
          enemy.alive = false;
          this.invaderNavigation.delete(enemy.id);
          this.cancelInvaderReplan(enemy.id);
        }
      } else if (decisionDue && navigation.retryRemaining <= 0) {
        this.scheduleInvaderReplan(enemy.id, false);
      }
  }

  private scheduleSimulation(enemyId: string, absoluteTick: number): void {
    const current = this.nextSimulationTick.get(enemyId);
    if (current !== undefined && current <= absoluteTick) return;
    this.nextSimulationTick.set(enemyId, absoluteTick);
    this.simulationWheel[absoluteTick % this.simulationWheel.length]!.add(enemyId);
  }

  updateSpawning(delta: number): void {
    this.pruneInvaderWaveQueue();
    const spawnGate = this.core.authoredWorld
      ? this.core.authoredSpawnGate(this.core.currentZone)
      : this.core.livingGateInZone(this.core.currentZone);
    if (!spawnGate) {
      this.invaderSpawnAccumulator = 0;
      this.invaderSpawnReleaseAccumulator = 0;
      this.invaderWaveIndex = 0;
      this.releasedInSpawnGroup = 0;
      this.invaderWaveQueue.length = 0;
      this.pendingInvaders = 0;
      return;
    }
    if (!this.initialSpawnDelayCompleted) {
      if (this.core.elapsed + SIMULATION_EPSILON < INVADER_INITIAL_SPAWN_DELAY_SECONDS) {
        this.invaderSpawnAccumulator = 0;
        this.invaderSpawnReleaseAccumulator = 0;
        return;
      }
      this.initialSpawnDelayCompleted = true;
      this.invaderWaveIndex = 1;
      this.enqueueInvaderWave(
        spawnGate.id,
        this.core.currentZone,
        waveBatchSize("day", this.core.options.difficulty, 0, INVADER_DAY_WAVES),
      );
    }
    this.invaderSpawnReleaseAccumulator += delta;
    while (this.invaderWaveQueue.length > 0) {
      const releaseDelay = this.releasedInSpawnGroup >= INVADER_SPAWN_GROUP_SIZE
        ? INVADER_SPAWN_GROUP_PAUSE_SECONDS
        : INVADER_MICRO_SPAWN_INTERVAL_SECONDS;
      if (this.invaderSpawnReleaseAccumulator + SIMULATION_EPSILON < releaseDelay) break;
      this.invaderSpawnReleaseAccumulator -= releaseDelay;
      if (this.releasedInSpawnGroup >= INVADER_SPAWN_GROUP_SIZE) this.releasedInSpawnGroup = 0;
      const released = this.releaseOldestInvaderWave();
      if (released > 0) this.releasedInSpawnGroup += released;
    }
    if (this.core.phase !== "day" && this.core.phase !== "night") return;
    const isNight = this.core.phase === "night";
    const waveCount = isNight ? INVADER_NIGHT_WAVES : INVADER_DAY_WAVES;
    const initialDay = this.core.day === 1 && this.core.phase === "day";
    const interval = initialDay
      ? (durations[this.core.options.mode].day - INVADER_INITIAL_SPAWN_DELAY_SECONDS) / Math.max(1, waveCount - 1)
      : durations[this.core.options.mode][this.core.phase] / waveCount;
    this.invaderSpawnAccumulator += delta;
    if (this.invaderSpawnAccumulator + SIMULATION_EPSILON < interval) return;
    this.invaderSpawnAccumulator = Math.max(0, this.invaderSpawnAccumulator - interval);
    const count = waveBatchSize(this.core.phase, this.core.options.difficulty, this.invaderWaveIndex, waveCount);
    this.invaderWaveIndex = Math.min(waveCount, this.invaderWaveIndex + 1);
    this.enqueueInvaderWave(spawnGate.id, this.core.currentZone, count);
  }

  /** @internal called by the GameCore test bridge. */
  enqueueWave(gateEnemyId: string, zone: ZoneId, count: number): void {
    this.enqueueInvaderWave(gateEnemyId, zone, count);
  }

  /** @internal called by the GameCore test bridge. */
  releaseOldestWave(): void {
    this.releaseOldestInvaderWave();
  }

  /** @internal called by the GameCore test bridge. */
  pruneWaveQueue(): void {
    this.pruneInvaderWaveQueue();
  }

  /** @internal called by the GameCore test bridge. */
  spawnPosition(zone: ZoneId, gateEnemy: CoreEnemy, spawnIndex: number): { x: number; y: number } {
    return this.invaderSpawnPosition(zone, gateEnemy, spawnIndex);
  }

  /** @internal called by the GameCore test bridge. */
  scheduleReplan(enemyId: string, allowRandom: boolean): void {
    this.scheduleInvaderReplan(enemyId, allowRandom);
  }

  /** @internal called by the GameCore test bridge. */
  releaseReplans(
    playerTargets: ReadonlyMap<string, CorePlayer>,
    playerRooms: ReadonlySet<CoreRoomId>,
  ): void {
    this.releasePendingInvaderReplans(playerTargets, playerRooms);
  }

  retireInactive(): void {
    for (const [id, enemy] of this.core.enemies) {
      if (enemy.behavior !== "invader" || enemy.alive) continue;
      this.core.enemies.delete(id);
      this.invaderNavigation.delete(id);
      this.invaderTiers.delete(id);
      this.nextSimulationTick.delete(id);
      this.cancelInvaderReplan(id);
      this.core.forgetEnemyMarks(id);
      this.liveInvaders = Math.max(0, this.liveInvaders - 1);
      this.retiredInvaders += 1;
    }
  }

  private collectPlayerRooms(output: Set<CoreRoomId>): void {
    output.clear();
    for (const player of this.core.players.values()) {
      if (player.alive && player.connected) output.add(player.roomId);
    }
  }

  /** Fills `output` with each invader's nearest in-zone player target. */
  private assignInvaderPlayerTargets(output: Map<string, CorePlayer>): void {
    output.clear();
    const playerZones = this.playerZoneScratch;
    playerZones.length = 0;
    for (const player of this.core.players.values()) {
      if (!player.alive || !player.connected) continue;
      playerZones.push({ player, zone: this.core.rooms.get(player.roomId)?.zone });
    }
    for (const enemy of this.core.enemies.values()) {
      if (!enemy.alive || enemy.behavior !== "invader") continue;
      if (this.invaderNavigation.get(enemy.id)?.targetPreference === "base") continue;
      const enemyZone = this.core.rooms.get(enemy.roomId)?.zone;
      let selected: CorePlayer | null = null;
      let selectedDistanceSquared = Number.POSITIVE_INFINITY;
      for (const entry of playerZones) {
        if (entry.zone !== enemyZone) continue;
        const player = entry.player;
        const radius = enemy.targetId === player.userId ? INVADER_RELEASE_RADIUS : INVADER_AGGRO_RADIUS;
        const dx = player.x - enemy.x;
        const dy = player.y - enemy.y;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared > radius * radius) continue;
        if (distanceSquared < selectedDistanceSquared
          || (distanceSquared === selectedDistanceSquared && player.userId.localeCompare(selected?.userId ?? "") < 0)) {
          selected = player;
          selectedDistanceSquared = distanceSquared;
        }
      }
      if (selected) output.set(enemy.id, selected);
    }
  }

  private nearestInvaderPlayerTarget(enemy: CoreEnemy): CorePlayer | null {
    const enemyZone = this.core.rooms.get(enemy.roomId)?.zone;
    let selected: CorePlayer | null = null;
    let selectedDistanceSquared = Number.POSITIVE_INFINITY;
    for (const player of this.core.players.values()) {
      if (!player.alive || !player.connected || this.core.rooms.get(player.roomId)?.zone !== enemyZone) continue;
      const dx = player.x - enemy.x;
      const dy = player.y - enemy.y;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > INVADER_AGGRO_RADIUS * INVADER_AGGRO_RADIUS) continue;
      if (distanceSquared < selectedDistanceSquared
        || (distanceSquared === selectedDistanceSquared && player.userId.localeCompare(selected?.userId ?? "") < 0)) {
        selected = player;
        selectedDistanceSquared = distanceSquared;
      }
    }
    return selected;
  }

  private invaderWarmRooms(playerRooms: ReadonlySet<CoreRoomId>): ReadonlySet<CoreRoomId> {
    const key = [...playerRooms].sort().join("|");
    if (this.warmRoomCache?.key === key) return this.warmRoomCache.rooms;
    const visited = new Set<CoreRoomId>(playerRooms);
    let frontier = [...playerRooms];
    for (let depth = 0; depth < 2; depth += 1) {
      const next: CoreRoomId[] = [];
      for (const roomId of frontier) {
        for (const connected of this.core.rooms.get(roomId)?.connections ?? []) {
          if (visited.has(connected)) continue;
          visited.add(connected);
          next.push(connected);
        }
      }
      frontier = next;
    }
    this.warmRoomCache = { key, rooms: visited };
    return visited;
  }

  private invaderBaseDestination(enemy: CoreEnemy): CoreRoomId {
    if (this.core.authoredWorld) return this.core.authoredWorld.baseRoomId;
    const zone = this.core.rooms.get(enemy.roomId)?.zone ?? 1;
    return this.core.maps.zones[zone - 1].startRoomId;
  }

  private createInvaderNavigation(
    enemy: CoreEnemy,
    targetPreference: InvaderNavigation["targetPreference"] = hashSeed(enemy.id) % 2 === 0 ? "player" : "base",
  ): InvaderNavigation {
    return {
      targetPreference,
      replanSequence: 0,
      targetRoomId: null,
      portalPassed: false,
      corridorWaypointIndex: 0,
      corridorConnectionId: null,
      retryRemaining: 0,
      stallElapsed: 0,
      stallX: enemy.x,
      stallY: enemy.y,
      blockedEdge: null,
      blockedUntil: 0,
      accumulatedDelta: 0,
      cohort: hashSeed(enemy.id),
      lastUpdateAt: this.simulationElapsed,
      nextDecisionTick: this.invaderSimulationTick,
    };
  }

  private enqueueInvaderWave(gateEnemyId: string, zone: ZoneId, count: number): void {
    const available = Math.max(0, MAX_PENDING_INVADERS - this.pendingInvaders);
    const accepted = Math.min(Math.max(0, Math.floor(count)), available);
    if (accepted > 0) {
      this.invaderWaveQueue.push({ gateEnemyId, zone, remaining: accepted, queuedAt: this.core.elapsed });
      this.pendingInvaders += accepted;
    }
    if (accepted < count) this.invaderCapHits += 1;
  }

  private releaseOldestInvaderWave(): number {
    const batch = this.invaderWaveQueue[0];
    if (!batch) return 0;
    const gate = this.core.enemies.get(batch.gateEnemyId);
    if (!gate?.alive || gate.kind !== "gate") return 0;
    const available = Math.max(0, this.maxLiveInvaders - this.liveInvaders);
    const requestedCount = Math.min(batch.remaining, available, INVADER_MICRO_SPAWN_COUNT);
    if (available < batch.remaining && requestedCount === available) this.invaderCapHits += 1;
    let spawnCount = 0;
    while (spawnCount < requestedCount) {
      const spawn = this.invaderSpawnPosition(batch.zone, gate, this.invaderSerial);
      const congested = this.isInvaderSpawnCongested(spawn.x, spawn.y);
      if (congested) break;
      this.spawn(batch.zone, batch.gateEnemyId, true);
      this.microSpawnedInvaders += 1;
      spawnCount += 1;
    }
    batch.remaining -= spawnCount;
    this.pendingInvaders = Math.max(0, this.pendingInvaders - spawnCount);
    if (batch.remaining <= 0) this.invaderWaveQueue.shift();
    return spawnCount;
  }

  private isInvaderSpawnCongested(x: number, y: number): boolean {
    const minimumDistanceSquared = (ACTOR_COLLISION_RADIUS * 2 + 4) ** 2;
    for (const enemy of this.core.enemies.values()) {
      if (!enemy.alive || enemy.behavior !== "invader") continue;
      const dx = enemy.x - x;
      const dy = enemy.y - y;
      if (dx * dx + dy * dy < minimumDistanceSquared) return true;
    }
    return false;
  }

  private invaderSpawnPosition(zone: ZoneId, gate: CoreEnemy, spawnIndex: number): { x: number; y: number } {
    const roomCenter = this.core.roomWorldCenterOf(gate.roomId);
    const dx = roomCenter.x - gate.x;
    const dy = roomCenter.y - gate.y;
    const distance = Math.hypot(dx, dy) || 1;
    const world = this.core.zoneWorlds.get(zone);
    const roomRect = this.core.roomRectOf(gate.roomId);
    const slot = spawnIndex % INVADER_SPAWN_SLOTS;
    const angle = slot * Math.PI * (3 - Math.sqrt(5));
    const radius = 72 + Math.floor(slot / 6) * 48;
    const anchorX = gate.x + dx / distance * 132;
    const anchorY = gate.y + dy / distance * 132;
    const desiredX = clamp(anchorX + Math.cos(angle) * radius, roomRect.x + 72, roomRect.x + roomRect.width - 72);
    const desiredY = clamp(anchorY + Math.sin(angle) * radius, roomRect.y + 72, roomRect.y + roomRect.height - 72);
    return world
      ? resolveWalkablePoint(world.rects, desiredX, desiredY, gate.x, gate.y)
      : { x: gate.x, y: gate.y };
  }

  private pruneInvaderWaveQueue(): void {
    for (let index = this.invaderWaveQueue.length - 1; index >= 0; index -= 1) {
      const batch = this.invaderWaveQueue[index]!;
      const gate = this.core.enemies.get(batch.gateEnemyId);
      if (!gate || gate.kind !== "gate" || !gate.alive || batch.zone !== this.core.currentZone) {
        this.invaderWaveQueue.splice(index, 1);
        this.pendingInvaders = Math.max(0, this.pendingInvaders - batch.remaining);
      }
    }
  }

  private scheduleInvaderReplan(enemyId: string, allowRandom: boolean): void {
    const priority = this.invaderReplanPriority(enemyId);
    const previous = this.pendingInvaderReplans.get(enemyId);
    if (!previous) {
      this.pendingReplanQueuedAt.set(enemyId, this.core.elapsed);
      this.pendingInvaderReplans.set(enemyId, { allowRandom, priority });
      this.pendingReplanQueues[priority].push(enemyId);
      return;
    }
    previous.allowRandom ||= allowRandom;
    if (priority < previous.priority) {
      previous.priority = priority;
      this.pendingReplanQueues[priority].push(enemyId);
    }
  }

  private releasePendingInvaderReplans(
    playerTargets: ReadonlyMap<string, CorePlayer>,
    playerRooms: ReadonlySet<CoreRoomId>,
  ): void {
    if (this.pendingInvaderReplans.size === 0) {
      for (let priority = 0; priority < this.pendingReplanQueues.length; priority += 1) {
        this.pendingReplanQueues[priority]!.length = 0;
        this.pendingReplanHeads[priority as ReplanPriority] = 0;
      }
      return;
    }
    let released = 0;
    for (let priority = 0 as ReplanPriority; priority <= 2 && released < INVADER_REPLAN_BUDGET_PER_TICK; priority = (priority + 1) as ReplanPriority) {
      const queue = this.pendingReplanQueues[priority];
      while (this.pendingReplanHeads[priority] < queue.length && released < INVADER_REPLAN_BUDGET_PER_TICK) {
        const enemyId = queue[this.pendingReplanHeads[priority]++]!;
        const pending = this.pendingInvaderReplans.get(enemyId);
        if (!pending || pending.priority !== priority) continue;
        const enemy = this.core.enemies.get(enemyId);
        const navigation = this.invaderNavigation.get(enemyId);
        if (!enemy?.alive || enemy.behavior !== "invader" || !navigation) {
          this.cancelInvaderReplan(enemyId);
          continue;
        }
        const target = playerTargets.get(enemyId);
        const currentPriority: ReplanPriority = target?.roomId === enemy.roomId || playerRooms.has(enemy.roomId)
          ? 0
          : navigation.blockedEdge !== null && navigation.blockedUntil > this.core.elapsed ? 1 : 2;
        if (currentPriority < pending.priority) {
          pending.priority = currentPriority;
          this.pendingReplanQueues[currentPriority].push(enemyId);
          continue;
        }
        const allowRandom = pending.allowRandom;
        this.cancelInvaderReplan(enemyId);
        this.replanInvader(enemy, navigation, allowRandom);
        this.completedInvaderReplans += 1;
        released += 1;
      }
      if (this.pendingReplanHeads[priority] === queue.length) {
        queue.length = 0;
        this.pendingReplanHeads[priority] = 0;
      }
    }
  }

  private invaderReplanPriority(enemyId: string): ReplanPriority {
    const enemy = this.core.enemies.get(enemyId);
    const navigation = this.invaderNavigation.get(enemyId);
    if (!enemy || !navigation) return 2;
    const target = this.playerTargetScratch.get(enemyId);
    if (target?.roomId === enemy.roomId || this.playerRoomsScratch.has(enemy.roomId)) return 0;
    if (navigation.blockedEdge !== null && navigation.blockedUntil > this.core.elapsed) return 1;
    return 2;
  }

  private cancelInvaderReplan(enemyId: string): void {
    this.pendingInvaderReplans.delete(enemyId);
    this.pendingReplanQueuedAt.delete(enemyId);
  }

  private replanInvader(enemy: CoreEnemy, navigation: InvaderNavigation, allowRandom: boolean): void {
    this.cancelInvaderReplan(enemy.id);
    const destination = enemy.targetId && enemy.targetId !== "base"
      ? this.core.players.get(enemy.targetId)?.roomId
      : this.invaderBaseDestination(enemy);
    navigation.targetRoomId = destination ?? null;
    navigation.portalPassed = false;
    navigation.corridorWaypointIndex = 0;
    navigation.corridorConnectionId = null;
    navigation.replanSequence += 1;
    this.resetInvaderStall(enemy, navigation);
    if (!destination) {
      enemy.path = [enemy.roomId];
      enemy.pathIndex = 0;
      navigation.retryRemaining = INVADER_RETRY_SECONDS;
      return;
    }

    const path = this.findInvaderPath(enemy, destination, navigation, allowRandom);
    enemy.path = path ?? [enemy.roomId];
    enemy.pathIndex = 0;
    navigation.retryRemaining = path ? 0 : INVADER_RETRY_SECONDS;
  }

  private findInvaderPath(
    enemy: CoreEnemy,
    destination: CoreRoomId,
    navigation: InvaderNavigation,
    allowRandom: boolean,
  ): CoreRoomId[] | null {
    const shortest = this.shortestInvaderPath(enemy.roomId, destination, navigation);
    if (!shortest || !allowRandom || shortest.length <= 1) return shortest;
    const random = createSeededRandom(`${this.core.options.seed}:${enemy.id}:${navigation.replanSequence}`);
    if (random.next() >= 0.2) return shortest;

    const alternatives = this.invaderSimplePaths(
      enemy.roomId,
      destination,
      shortest.length + 2,
      navigation,
    ).filter((path) => path.length > shortest.length);
    if (alternatives.length === 0) return shortest;
    const weights = alternatives.map((path) => 1 / (path.length - shortest.length));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let roll = random.next() * total;
    for (let index = 0; index < alternatives.length; index += 1) {
      roll -= weights[index] as number;
      if (roll <= 0) return alternatives[index] as CoreRoomId[];
    }
    return alternatives.at(-1) as CoreRoomId[];
  }

  private shortestInvaderPath(
    from: CoreRoomId,
    destination: CoreRoomId,
    navigation: InvaderNavigation,
  ): CoreRoomId[] | null {
    const blocked = navigation.blockedEdge && navigation.blockedUntil > this.core.elapsed;
    if (!blocked) {
      const key = `invader:${this.core.doorTopologyKey()}:${from}>${destination}`;
      const cached = this.routeCache.get(key);
      if (cached) return [...cached];
      const path = this.core.weightedRoomPath(from, destination, (current, next) => (
        this.isInvaderEdgeTraversable(current, next, navigation)
      ));
      if (path) this.routeCache.set(key, path);
      return path;
    }
    return this.core.weightedRoomPath(from, destination, (current, next) => (
      this.isInvaderEdgeTraversable(current, next, navigation)
    ));
  }

  private invaderSimplePaths(
    from: CoreRoomId,
    destination: CoreRoomId,
    maxRooms: number,
    navigation: InvaderNavigation,
  ): CoreRoomId[][] {
    const paths: CoreRoomId[][] = [];
    const visit = (current: CoreRoomId, path: CoreRoomId[]): void => {
      if (path.length > maxRooms) return;
      if (current === destination) {
        paths.push(path);
        return;
      }
      for (const next of [...(this.core.rooms.get(current)?.connections ?? [])].sort()) {
        if (path.includes(next) || !this.isInvaderEdgeTraversable(current, next, navigation)) continue;
        visit(next, [...path, next]);
      }
    };
    visit(from, [from]);
    return paths;
  }

  private isInvaderEdgeTraversable(
    from: CoreRoomId,
    to: CoreRoomId,
    navigation: InvaderNavigation,
  ): boolean {
    const edge = invaderEdgeKey(from, to);
    if (navigation.blockedEdge === edge && navigation.blockedUntil > this.core.elapsed) return false;
    const fromRoom = this.core.rooms.get(from);
    const toRoom = this.core.rooms.get(to);
    if (!fromRoom || !toRoom || (!this.core.authoredWorld && fromRoom.zone !== toRoom.zone) || !fromRoom.connections.includes(to)) return false;
    const door = this.core.doors.get(doorId(from, to));
    return Boolean(door?.open && !door.locked);  }

  private moveInvaderThroughConnection(
    enemy: CoreEnemy,
    navigation: InvaderNavigation,
    nextRoomId: CoreRoomId,
    delta: number,
  ): void {
    const room = this.core.rooms.get(enemy.roomId);
    const nextRoom = this.core.rooms.get(nextRoomId);
    if (!room || !nextRoom) {
      this.scheduleInvaderReplan(enemy.id, false);
      return;
    }
    const authoredConnection = this.core.authoredConnectionsByEdge.get(invaderEdgeKey(enemy.roomId, nextRoomId));
    const corridor = authoredConnection ? null : corridorRectBetween(
      { x: room.gridX, y: room.gridY },
      { x: nextRoom.gridX, y: nextRoom.gridY },
    );
    if (!corridor && !authoredConnection) {
      navigation.blockedEdge = invaderEdgeKey(enemy.roomId, nextRoomId);
      navigation.blockedUntil = this.core.elapsed + INVADER_BLOCKED_EDGE_SECONDS;
      this.scheduleInvaderReplan(enemy.id, false);
      return;
    }
    const authoredPoints = authoredConnection
      ? (authoredConnection.from === enemy.roomId ? authoredConnection.points : [...authoredConnection.points].reverse())
      : null;
    if (authoredPoints && navigation.corridorConnectionId !== authoredConnection?.id) {
      navigation.corridorWaypointIndex = this.core.furthestReachableConnectionPoint(enemy.x, enemy.y, authoredPoints);
      navigation.corridorConnectionId = authoredConnection?.id ?? null;
    }
    if (authoredPoints && navigation.corridorWaypointIndex < authoredPoints.length) {
      const rawTarget = authoredPoints[navigation.corridorWaypointIndex]!;
      const toward = authoredPoints[navigation.corridorWaypointIndex + 1] ?? this.core.roomWorldCenterOf(nextRoomId);
      const target = this.invaderLanePoint(enemy, rawTarget, toward);
      if (Math.hypot(target.x - enemy.x, target.y - enemy.y) <= 20) {
        navigation.corridorWaypointIndex += 1;
        if (navigation.corridorWaypointIndex >= authoredPoints.length) navigation.portalPassed = true;
      }
      else {
        this.moveInvaderWorld(enemy, navigation, target.x, target.y, delta, null);
        return;
      }
    }
    const rawPortal = authoredPoints?.at(-1) ?? authoredConnection?.portal ?? { x: corridor!.x + corridor!.width / 2, y: corridor!.y + corridor!.height / 2 };
    const nextCenter = this.core.roomWorldCenterOf(nextRoomId);
    const portal = this.invaderLanePoint(enemy, rawPortal, nextCenter);
    if (!navigation.portalPassed && Math.hypot(portal.x - enemy.x, portal.y - enemy.y) <= 20) {
      navigation.portalPassed = true;
      this.resetInvaderStall(enemy, navigation);
    }
    const target = navigation.portalPassed ? this.invaderFormationPoint(enemy, nextRoomId) : portal;
    this.moveInvaderWorld(enemy, navigation, target.x, target.y, delta, nextRoomId);
  }

  private invaderLanePoint(
    enemy: CoreEnemy,
    point: Readonly<{ x: number; y: number }>,
    toward: Readonly<{ x: number; y: number }>,
  ): { x: number; y: number } {
    const dx = toward.x - point.x;
    const dy = toward.y - point.y;
    const length = Math.hypot(dx, dy) || 1;
    const lane = hashSeed(enemy.id) % 3 - 1;
    return {
      x: point.x - dy / length * lane * INVADER_CORRIDOR_LANE_OFFSET,
      y: point.y + dx / length * lane * INVADER_CORRIDOR_LANE_OFFSET,
    };
  }

  private invaderFormationPoint(enemy: CoreEnemy, roomId: CoreRoomId): { x: number; y: number } {
    const center = this.core.roomWorldCenterOf(roomId);
    const rect = this.core.roomRectOf(roomId);
    const slot = hashSeed(enemy.id) % INVADER_SPAWN_SLOTS;
    const angle = slot * Math.PI * (3 - Math.sqrt(5));
    const radius = 48 + Math.floor(slot / 8) * 44;
    return {
      x: clamp(center.x + Math.cos(angle) * radius, rect.x + 64, rect.x + rect.width - 64),
      y: clamp(center.y + Math.sin(angle) * radius, rect.y + 64, rect.y + rect.height - 64),
    };
  }

  private moveInvaderWorld(
    enemy: CoreEnemy,
    navigation: InvaderNavigation,
    targetX: number,
    targetY: number,
    delta: number,
    expectedRoomId: CoreRoomId | null,
  ): void {
    const previousX = enemy.x;
    const previousY = enemy.y;
    const previousRoomId = enemy.roomId;
    const zone = this.core.rooms.get(enemy.roomId)?.zone;
    const world = zone ? this.core.zoneWorlds.get(zone) : null;
    if (!world) {
      navigation.retryRemaining = INVADER_RETRY_SECONDS;
      return;
    }
    const dx = targetX - enemy.x;
    const dy = targetY - enemy.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= 0) return;
    const step = Math.min(distance, enemy.speed * delta);
    const desiredX = enemy.x + dx / distance * step;
    const desiredY = enemy.y + dy / distance * step;
    const resolved = this.core.authoredSpatialIndex
      ? resolveWalkableDiscPointIndexed(this.core.authoredSpatialIndex, desiredX, desiredY, enemy.x, enemy.y, ACTOR_COLLISION_RADIUS)
      : resolveWalkablePoint(world.rects, desiredX, desiredY, enemy.x, enemy.y);
    enemy.x = resolved.x;
    enemy.y = resolved.y;

    const containing = this.core.authoredWorld
      ? this.core.authoredRoomAt(enemy.x, enemy.y)
      : roomContainingPoint(world.grid, enemy.x, enemy.y) as CoreRoomId | null;
    if (expectedRoomId && containing === expectedRoomId) {
      enemy.roomId = expectedRoomId;
      enemy.pathIndex += 1;
      navigation.portalPassed = false;
      navigation.corridorWaypointIndex = 0;
      navigation.corridorConnectionId = null;
      this.core.markEnemyTransform(enemy, previousX, previousY, previousRoomId, delta);
      this.resetInvaderStall(enemy, navigation);
      return;
    }
    if (containing && containing !== enemy.roomId && containing !== expectedRoomId) {
      enemy.roomId = containing;
      this.core.markEnemyTransform(enemy, previousX, previousY, previousRoomId, delta);
      this.scheduleInvaderReplan(enemy.id, false);
      return;
    }
    this.core.markEnemyTransform(enemy, previousX, previousY, previousRoomId, delta);
    this.updateInvaderStall(enemy, navigation, delta, distance, expectedRoomId);
  }

  private updateInvaderStall(
    enemy: CoreEnemy,
    navigation: InvaderNavigation,
    delta: number,
    goalDistance: number,
    nextRoomId: CoreRoomId | null,
  ): void {
    if (goalDistance <= 24) {
      this.resetInvaderStall(enemy, navigation);
      return;
    }
    navigation.stallElapsed += delta;
    if (navigation.stallElapsed + SIMULATION_EPSILON < INVADER_STALL_SECONDS) return;
    const progress = Math.hypot(enemy.x - navigation.stallX, enemy.y - navigation.stallY);
    if (progress < INVADER_STALL_DISTANCE) {
      if (nextRoomId) {
        navigation.blockedEdge = invaderEdgeKey(enemy.roomId, nextRoomId);
        navigation.blockedUntil = this.core.elapsed + INVADER_BLOCKED_EDGE_SECONDS;
      }
      this.scheduleInvaderReplan(enemy.id, false);
      navigation.retryRemaining = INVADER_RETRY_SECONDS;
      return;
    }
    this.resetInvaderStall(enemy, navigation);
  }

  private resetInvaderStall(enemy: CoreEnemy, navigation: InvaderNavigation): void {
    navigation.stallElapsed = 0;
    navigation.stallX = enemy.x;
    navigation.stallY = enemy.y;
  }

}
