import { PROTOCOL_VERSION, type CombatAttackEvent, type HeroClassId, type PlayerInputCommand } from "@five-days/protocol";
import {
  rollPartyHiddenDrops,
  type EquipmentSlot,
  type PersonalHiddenDrop,
} from "./v02/equipment";
import type { RoomId, ThreeZoneMap, ZoneId } from "./v02/map";
import { createSeededRandom, hashSeed } from "./v02/random";
import {
  addAugmentStack,
  addExperience,
  createAugmentDraft,
  xpRequiredForNextLevel,
  type AugmentId,
  type AugmentStacks,
} from "./v02/progression";
import {
  BOSS_ROOM_ID,
  CLASS_COMBAT_RULES,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  WAYPOINT_HOLD_SECONDS,
  augmentAttackBonus,
  createBossEnemy,
  createEmptyEquipment,
  createInvaderEnemy,
  createRuntimeWorld,
  createSeededRoomEnemy,
  doorId,
  enemyFanPatternAngles,
  enemyFloorPatternCircles,
  enemyPatternConfig,
  equipmentBonuses,
  equipmentPower,
  isPlayerOnWaypoint,
  makeDraftId,
  movePlayerWorld,
  selectNearestConeEnemy,
  waypointId,
  type CoreDoor,
  type CoreDrop,
  type CoreEnemy,
  type CoreEquipmentBonuses,
  type CoreEquipmentLoadout,
  type CoreRoom,
  type CoreRoomId,
  type CoreUpgradeDraft,
  type CoreWaypoint,
  type CoreWorldDefinition,
  type RuntimeWorld,
  type TravelIntent,
} from "./v02/simulation";
import { autoSkillDefinition, type AutoSkillId } from "./v02/skills";
import {
  bossWorldRect,
  buildWorldFromRooms,
  corridorRectBetween,
  findWalkableDiscPath,
  createWalkableSpatialIndex,
  isWalkableDiscLineIndexed,
  resolveWalkableDiscPointIndexed,
  isWalkableDiscLine,
  isWalkableLine,
  resolveWalkablePoint,
  roomContainingPoint,
  roomWorldRect,
  resolveWalkableDiscPoint,
  type WorldRect,
  type WalkableSpatialIndex,
} from "./v02/world";

export * from "./v02";

export type CorePhase = "lobby" | "day" | "night" | "standby" | "boss" | "ended";
export type CoreResult = "victory" | "defeat" | "abandoned";
export type CoreNotice = Readonly<{ userId: string; code: "ZONE_GATE_LOCKED"; message: string }>;

export type CoreCombatStats = Readonly<{
  attackDamage: number;
  defense: number;
  criticalChance: number;
  criticalDamage: number;
  attacksPerSecond: number;
  attackRange: number;
  moveSpeed: number;
}>;

export type CorePlayer = {
  userId: string;
  displayName: string;
  heroClass: HeroClassId;
  roomId: CoreRoomId;
  x: number;
  y: number;
  aim: number;
  hp: number;
  maxHp: number;
  level: number;
  teamPower: number;
  alive: boolean;
  ready: boolean;
  connected: boolean;
  lastSeq: number;
  lastInputAt: number;
  lastButtons: number;
  inputX: number;
  inputY: number;
  equipment: CoreEquipmentLoadout;
  upgrades: AugmentStacks;
  upgradeDraft: CoreUpgradeDraft | null;
  pendingUpgradeLevels: number[];
  draftIndex: number;
  autoAttackCooldown: number;
  attackCount: number;
  qCooldown: number;
  eCooldown: number;
  dashCooldown: number;
  skillSequence: number;
  lastSkillId: "q" | "e" | "dash" | null;
  skillTargetX: number;
  skillTargetY: number;
  skillRadius: number;
  lastAttackTargetId: string | null;
  lastAttackCritical: boolean;
  consecutiveHits: number;
  damage: number;
  bossDamage: number;
  kills: number;
  deaths: number;
  structuresBuilt: number;
  goldSpent: number;
  gatesDestroyed: number;
  /** Assigned to AI-controlled party members so the server can drive them. */
  aiRole?: "follower" | "defender";
};

export type GameCoreOptions = {
  mode: "prototype" | "full";
  difficulty: "easy" | "normal" | "hard";
  seed: string;
  minimumPlayers?: number;
  /** Per-room circuit breaker for simultaneously active gate invaders. */
  maxLiveInvaders?: number;
  /** Optional local-authored world. Omitted for the production procedural world. */
  world?: CoreWorldDefinition;
  /** Optional server-side LOD. The authoritative clock and combat remain 60Hz. */
  invaderUpdateRates?: Readonly<{ warmHz: number; coldHz: number }>;
};

export type TeamProgress = Readonly<{
  level: number;
  xp: number;
  xpToNext: number;
}>;

/** Plain authoritative view shared by Colyseus schema sync and local editor play. */
export type CoreViewSnapshot = Readonly<{
  phase: CorePhase;
  result: CoreResult | null;
  resultReason: string;
  day: number;
  elapsed: number;
  phaseRemaining: number;
  baseHp: number;
  baseMaxHp: number;
  gold: number;
  currentZone: ZoneId;
  teamLevel: number;
  teamXp: number;
  teamXpToNext: number;
  players: readonly CorePlayer[];
  rooms: readonly CoreRoom[];
  doors: readonly CoreDoor[];
  enemies: readonly CoreEnemy[];
  drops: readonly CoreDrop[];
  waypoints: readonly CoreWaypoint[];
}>;

const durations = {
  prototype: { day: 60, night: 25, standby: 5 },
  full: { day: 210, night: 75, standby: 15 },
} as const;

const RESOURCE_PRODUCTION_SECONDS = 5;
const STATIC_RESPAWN_SECONDS = { prototype: 30, full: 90 } as const;
const SIMULATION_EPSILON = 1e-9;
export const ACTOR_COLLISION_RADIUS = 14;
const INVADER_AGGRO_RADIUS = 1_400;
const INVADER_RELEASE_RADIUS = 1_500;
const INVADER_COMBAT_RADIUS = 480;
const INVADER_BASE_RADIUS = 56;
const INVADER_RETRY_SECONDS = 0.5;
const INVADER_STALL_SECONDS = 0.75;
const INVADER_STALL_DISTANCE = 8;
const INVADER_BLOCKED_EDGE_SECONDS = 2;
const INVADER_DAY_WAVES = 8;
const INVADER_NIGHT_WAVES = 10;
const INVADER_SPAWN_SLOTS = 24;
const INVADER_MICRO_SPAWN_INTERVAL_SECONDS = 0.1;
const INVADER_MICRO_SPAWN_COUNT = 3;
const INVADER_REPLAN_BUDGET_PER_TICK = 8;
export const DEFAULT_MAX_LIVE_INVADERS = 256;
export const ABSOLUTE_MAX_LIVE_INVADERS = 384;
export const MAX_PENDING_INVADERS = 1_024;
const INVADER_CORRIDOR_LANE_OFFSET = 20;
const AI_FOLLOWER_GAP = 180;
const AI_PATH_REPLAN_SECONDS = 0.75;
const AI_PATH_TARGET_DRIFT = 96;
const AI_PATH_WAYPOINT_RADIUS = 32;
const authoredWalkableWithoutBossCache = new WeakMap<CoreWorldDefinition, readonly WorldRect[]>();

type InvaderNavigation = {
  replanSequence: number;
  targetRoomId: CoreRoomId | null;
  portalPassed: boolean;
  corridorWaypointIndex: number;
  corridorConnectionId: string | null;
  retryRemaining: number;
  stallElapsed: number;
  stallX: number;
  stallY: number;
  blockedEdge: string | null;
  blockedUntil: number;
  accumulatedDelta: number;
  cohort: number;
};

export type InvaderSimulationTiers = Readonly<{ hot: number; warm: number; cold: number }>;

type InvaderWaveBatch = {
  gateEnemyId: string;
  zone: ZoneId;
  remaining: number;
  queuedAt: number;
};

type AiFollowNavigation = {
  targetX: number;
  targetY: number;
  path: readonly Readonly<{ x: number; y: number }>[];
  waypointIndex: number;
  replanAt: number;
};

export class GameCore {
  readonly players = new Map<string, CorePlayer>();
  readonly maps: ThreeZoneMap;
  readonly rooms: Map<CoreRoomId, CoreRoom>;
  readonly doors: Map<string, CoreDoor>;
  readonly enemies: Map<string, CoreEnemy>;
  readonly waypoints: Map<string, CoreWaypoint>;
  readonly drops = new Map<string, CoreDrop>();
  readonly discoveredRooms = new Set<CoreRoomId>();

  phase: CorePhase = "lobby";
  currentZone: ZoneId = 1;
  day = 1;
  elapsed = 0;
  phaseRemaining = 0;
  baseMaxHp = 900;
  baseHp = this.baseMaxHp;
  gold = 100;
  teamLevel = 1;
  teamXp = 0;
  result: CoreResult | null = null;
  resultReason = "";

  private readonly minimumPlayers: number;
  private readonly authoredWorld: CoreWorldDefinition | null;
  private readonly maxLiveInvaders: number;
  private travelIntent: TravelIntent | null = null;
  private invaderSpawnAccumulator = 0;
  private invaderSpawnReleaseAccumulator = 0;
  private invaderWaveIndex = 0;
  private invaderSerial = 0;
  private readonly invaderWaveQueue: InvaderWaveBatch[] = [];
  private retiredInvaders = 0;
  private invaderCapHits = 0;
  private microSpawnedInvaders = 0;
  private completedInvaderReplans = 0;
  private compensatedPlayerAttacks = 0;
  private combatAttackEventCount = 0;
  private hiddenDropSerial = 0;
  private readonly resourceAccumulators = new Map<CoreRoomId, number>();
  private readonly vulnerableEnemies = new Map<string, { playerId: string; expiresAt: number }>();
  private readonly markedEnemies = new Map<string, { playerId: string; expiresAt: number }>();
  private readonly invaderNavigation = new Map<string, InvaderNavigation>();
  private readonly pendingInvaderReplans = new Map<string, boolean>();
  private readonly partyNavigation = new Map<string, { from: CoreRoomId; to: CoreRoomId; waypointIndex: number }>();
  private readonly aiFollowNavigation = new Map<string, AiFollowNavigation>();
  private readonly zoneWorlds = new Map<ZoneId, ReturnType<typeof buildWorldFromRooms>>();
  private readonly authoredSpatialIndex: WalkableSpatialIndex | null;
  private readonly authoredRoomCells = new Map<number, Map<number, CoreRoomId[]>>();
  private readonly roomRects = new Map<CoreRoomId, WorldRect>();
  private readonly roomCenters = new Map<CoreRoomId, Readonly<{ x: number; y: number }>>();
  private readonly authoredConnectionsByEdge = new Map<string, CoreWorldDefinition["connections"][number]>();
  private readonly routeCache = new Map<string, readonly CoreRoomId[]>();
  private readonly warmInvaderDivisor: number;
  private readonly coldInvaderDivisor: number;
  private invaderSimulationTick = 0;
  private invaderTierCounts: InvaderSimulationTiers = { hot: 0, warm: 0, cold: 0 };
  private warmRoomCache: { key: string; rooms: ReadonlySet<CoreRoomId> } | null = null;
  private authoredWalkableCache: { bossAccessible: boolean; rects: readonly WorldRect[] } | null = null;
  private readonly notices: CoreNotice[] = [];
  private readonly combatAttackEvents: CombatAttackEvent[] = [];
  private readonly noticeCooldowns = new Map<string, number>();

  constructor(readonly options: GameCoreOptions) {
    this.minimumPlayers = options.minimumPlayers ?? 3;
    this.authoredWorld = options.world ?? null;
    const requestedInvaderLimit = options.maxLiveInvaders ?? DEFAULT_MAX_LIVE_INVADERS;
    this.maxLiveInvaders = Number.isFinite(requestedInvaderLimit)
      ? Math.max(1, Math.min(ABSOLUTE_MAX_LIVE_INVADERS, Math.floor(requestedInvaderLimit)))
      : DEFAULT_MAX_LIVE_INVADERS;
    const warmHz = clampUpdateRate(options.invaderUpdateRates?.warmHz ?? 60);
    const coldHz = clampUpdateRate(options.invaderUpdateRates?.coldHz ?? 60);
    this.warmInvaderDivisor = Math.max(1, Math.round(60 / warmHz));
    this.coldInvaderDivisor = Math.max(this.warmInvaderDivisor, Math.round(60 / coldHz));
    const world = options.world
      ? createAuthoredRuntimeWorld(options.world, options.seed, options.difficulty)
      : createRuntimeWorld(options.seed, options.difficulty);
    this.maps = world.maps;
    this.rooms = world.rooms;
    this.doors = world.doors;
    this.enemies = world.enemies;
    this.waypoints = world.waypoints;
    this.authoredSpatialIndex = options.world ? createWalkableSpatialIndex(options.world.walkable, 256) : null;
    for (const room of this.rooms.values()) {
      const rect = room.rect ?? roomWorldRect({ x: room.gridX, y: room.gridY });
      this.roomRects.set(room.id, rect);
      this.roomCenters.set(room.id, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
      if (options.world) this.addRoomToSpatialCells(room.id, rect);
    }
    for (const connection of options.world?.connections ?? []) {
      this.authoredConnectionsByEdge.set(this.invaderEdgeKey(connection.from, connection.to), connection);
    }
    for (const zone of this.maps.zones) {
      this.zoneWorlds.set(zone.zone, options.world
        ? { rects: [...options.world.walkable], grid: new Map(), bossRect: this.roomRectOf(options.world.bossRoomId) }
        : buildWorldFromRooms(
          [...this.rooms.values()].filter((room) => room.zone === zone.zone && room.id !== BOSS_ROOM_ID),
          false,
        ));
    }
    this.discoverRoom(this.startRoomId());
  }

  get teamXpToNext(): number {
    return xpRequiredForNextLevel(this.teamLevel) ?? 0;
  }

  get teamProgress(): TeamProgress {
    return { level: this.teamLevel, xp: this.teamXp, xpToNext: this.teamXpToNext };
  }

  takeNotices(): CoreNotice[] {
    return this.notices.splice(0, this.notices.length);
  }

  get activeTravel(): Readonly<TravelIntent> | null {
    return this.travelIntent ? { ...this.travelIntent } : null;
  }

  get liveInvaderCount(): number {
    let count = 0;
    for (const enemy of this.enemies.values()) {
      if (enemy.alive && enemy.behavior === "invader") count += 1;
    }
    return count;
  }

  get pendingInvaderCount(): number {
    let count = 0;
    for (const batch of this.invaderWaveQueue) count += batch.remaining;
    return count;
  }

  get retiredInvaderCount(): number {
    return this.retiredInvaders;
  }

  get invaderCapHitCount(): number {
    return this.invaderCapHits;
  }

  get invaderSimulationTiers(): InvaderSimulationTiers {
    return { ...this.invaderTierCounts };
  }

  get invaderWorkMetrics(): Readonly<{
    microSpawned: number;
    pendingReplans: number;
    completedReplans: number;
    oldestPendingWaveSeconds: number;
    combatAttackEvents: number;
    compensatedAttacks: number;
  }> {
    return {
      microSpawned: this.microSpawnedInvaders,
      pendingReplans: this.pendingInvaderReplans.size,
      completedReplans: this.completedInvaderReplans,
      oldestPendingWaveSeconds: Math.max(0, this.elapsed - (this.invaderWaveQueue[0]?.queuedAt ?? this.elapsed)),
      combatAttackEvents: this.combatAttackEventCount,
      compensatedAttacks: this.compensatedPlayerAttacks,
    };
  }

  takeCombatAttackEvents(): CombatAttackEvent[] {
    return this.combatAttackEvents.splice(0, this.combatAttackEvents.length);
  }

  addPlayer(input: { userId: string; displayName: string; heroClass: HeroClassId }): CorePlayer {
    const existing = this.players.get(input.userId);
    if (existing) {
      existing.connected = true;
      if (!input.userId.startsWith("ai:")) existing.aiRole = undefined;
      return existing;
    }

    const rules = CLASS_COMBAT_RULES[input.heroClass];
    const startRoomId = this.startRoomId();
    const startCenter = this.roomWorldCenterOf(startRoomId);
    const player: CorePlayer = {
      ...input,
      roomId: startRoomId,
      x: startCenter.x + this.players.size * 36,
      y: startCenter.y,
      aim: 0,
      hp: rules.hp,
      maxHp: rules.hp,
      level: this.teamLevel,
      teamPower: rules.power,
      alive: true,
      ready: false,
      connected: true,
      lastSeq: -1,
      lastInputAt: -Infinity,
      lastButtons: 0,
      inputX: 0,
      inputY: 0,
      equipment: createEmptyEquipment(),
      upgrades: {},
      upgradeDraft: null,
      pendingUpgradeLevels: [],
      draftIndex: 0,
      autoAttackCooldown: 0,
      attackCount: 0,
      qCooldown: 0,
      eCooldown: 0,
      dashCooldown: 0,
      skillSequence: 0,
      lastSkillId: null,
      skillTargetX: startCenter.x,
      skillTargetY: startCenter.y,
      skillRadius: 0,
      lastAttackTargetId: null,
      lastAttackCritical: false,
      consecutiveHits: 0,
      damage: 0,
      bossDamage: 0,
      kills: 0,
      deaths: 0,
      structuresBuilt: 0,
      goldSpent: 0,
      gatesDestroyed: 0,
    };
    if (input.userId.startsWith("ai:")) {
      const existingAi = [...this.players.values()].filter((candidate) => candidate.aiRole).length;
      player.aiRole = existingAi === 0 ? "defender" : "follower";
    }
    for (let level = 2; level <= this.teamLevel; level += 1) player.pendingUpgradeLevels.push(level);
    this.players.set(input.userId, player);
    this.activateNextDraft(player);
    this.autoChooseAiUpgrades(player);
    this.discoverRoom(player.roomId);
    return player;
  }

  setConnected(userId: string, connected: boolean): void {
    const player = this.players.get(userId);
    if (!player) return;
    player.connected = connected;
    if (!connected) {
      player.inputX = 0;
      player.inputY = 0;
    }
  }

  takeOverPlayerWithAi(userId: string): boolean {
    if (this.phase === "lobby" || this.phase === "ended") return false;
    const player = this.players.get(userId);
    if (!player) return false;
    const hasDefender = [...this.players.values()].some((candidate) => (
      candidate.userId !== userId && candidate.aiRole === "defender"
    ));
    player.connected = true;
    player.aiRole = hasDefender ? "follower" : "defender";
    player.inputX = 0;
    player.inputY = 0;
    player.lastButtons = 0;
    return true;
  }

  setReady(userId: string, ready: boolean): boolean {
    if (this.phase !== "lobby") return false;
    const player = this.players.get(userId);
    if (!player) return false;
    player.ready = ready;
    if (this.players.size >= this.minimumPlayers && [...this.players.values()].every((value) => value.ready)) {
      this.phase = "day";
      this.phaseRemaining = durations[this.options.mode].day;
    }
    return true;
  }

  applyInput(userId: string, command: PlayerInputCommand): boolean {
    if (this.phase === "lobby" || this.phase === "ended") return false;
    const player = this.players.get(userId);
    if (!player || !player.alive || command.seq <= player.lastSeq) return false;
    player.lastSeq = command.seq;
    player.lastInputAt = this.elapsed;
    const magnitude = Math.hypot(command.payload.x, command.payload.y);
    const scale = magnitude > 1 ? 1 / magnitude : 1;
    player.inputX = command.payload.x * scale;
    player.inputY = command.payload.y * scale;
    player.aim = command.payload.aim;
    const risingButtons = command.payload.buttons & ~player.lastButtons;
    player.lastButtons = command.payload.buttons;
    if ((risingButtons & 1) !== 0) this.castSkill(userId, "q", player.aim);
    if ((risingButtons & 2) !== 0) this.castSkill(userId, "e", player.aim);
    if ((risingButtons & 4) !== 0) this.castSkill(userId, "dash", player.aim);
    return true;
  }

  update(deltaSeconds: number): void {
    if (this.phase === "lobby" || this.phase === "ended") return;
    const delta = Math.max(0, Math.min(0.1, deltaSeconds));
    this.elapsed += delta;
    this.updateAiPlayers();

    for (const player of this.players.values()) {
      player.autoAttackCooldown = Math.max(0, player.autoAttackCooldown - delta);
      player.qCooldown = Math.max(0, player.qCooldown - delta);
      player.eCooldown = Math.max(0, player.eCooldown - delta);
      player.dashCooldown = Math.max(0, player.dashCooldown - delta);
      if (!player.alive) continue;
      const rules = CLASS_COMBAT_RULES[player.heroClass];
      const transitioned = this.movePlayer(player, player.inputX * rules.speed * delta, player.inputY * rules.speed * delta);
      if (transitioned) this.discoverRoom(player.roomId);
    }

    if (this.phase === "day" || this.phase === "night" || this.phase === "boss") {
      this.updateAutoSkills();
      for (const player of this.players.values()) {
        if (player.connected && player.alive && player.autoAttackCooldown <= 0) this.performAutoAttack(player.userId);
      }
    }
    this.updateStaticEnemies(delta);
    this.updatePatternEnemies(delta);
    this.updateStaticRespawns(delta);
    this.updateInvaders(delta);
    this.retireInactiveInvaders();
    this.updateInvaderSpawning(delta);
    this.updateResourceProduction(delta);
    this.updateTravel(delta);
    this.refreshCurrentZone();

    if (this.phase === "boss") return;
    this.phaseRemaining -= delta;
    if (this.phaseRemaining > 0) return;

    if (this.phase === "day") this.transition("night");
    else if (this.phase === "night") this.transition("standby");
    else {
      this.day += 1;
      if (this.day > 5) this.finish("defeat", "마왕을 제한 시간 안에 쓰러뜨리지 못했습니다.");
      else this.transition("day");
    }
  }

  /**
   * Advances combat clocks for wall-clock time intentionally omitted by the
   * fixed-step room loop. Movement and enemy AI are not replayed, and each
   * player may attack only once, preventing an unbounded post-lag burst.
   */
  compensateSkippedCombatTime(deltaSeconds: number): number {
    if (this.phase === "lobby" || this.phase === "ended" || !Number.isFinite(deltaSeconds)) return 0;
    const delta = Math.max(0, deltaSeconds);
    if (delta <= 0) return 0;
    for (const player of this.players.values()) {
      player.autoAttackCooldown = Math.max(0, player.autoAttackCooldown - delta);
      player.qCooldown = Math.max(0, player.qCooldown - delta);
      player.eCooldown = Math.max(0, player.eCooldown - delta);
      player.dashCooldown = Math.max(0, player.dashCooldown - delta);
    }
    if (this.phase !== "day" && this.phase !== "night" && this.phase !== "boss") return 0;
    this.updateAutoSkills();
    let attacks = 0;
    for (const player of this.players.values()) {
      if (!player.connected || !player.alive || player.autoAttackCooldown > 0) continue;
      if (this.performAutoAttack(player.userId)) {
        attacks += 1;
        this.compensatedPlayerAttacks += 1;
      }
    }
    return attacks;
  }

  performAutoAttack(userId: string): CoreEnemy | null {
    const player = this.players.get(userId);
    if (!player || !player.alive || player.autoAttackCooldown > 0 || this.phase === "lobby" || this.phase === "ended") {
      return null;
    }
    const rules = CLASS_COMBAT_RULES[player.heroClass];
    const rangeMultiplier = 1 + (player.upgrades["area-power"] ?? 0) * 0.06
      + (player.heroClass === "swordsman" ? (player.upgrades.multishot ?? 0) * 0.1 : 0);
    const bladeRange = player.heroClass === "swordsman" && player.upgrades["swordsman-blade"] ? 240 : 0;
    const range = Math.max(rules.attackRange * rangeMultiplier, bladeRange);
    const cone = rules.coneHalfAngle * (player.heroClass === "swordsman" && player.upgrades["swordsman-whirlwind"] ? 1.45 : 1);
    const aimedTargets = this.enemiesInAttackCone(player, range, cone);
    const targets = aimedTargets.length > 0 ? aimedTargets : this.enemiesInAttackCone(player, range, Math.PI);
    const target = targets[0];
    if (!target) return null;

    player.attackCount += 1;
    if (player.lastAttackTargetId === target.id) player.consecutiveHits += 1;
    else {
      player.lastAttackTargetId = target.id;
      player.consecutiveHits = 1;
    }
    const haste = (player.upgrades.haste ?? 0) * 0.06;
    const equipmentHaste = equipmentBonuses(player.equipment).attackSpeedBonus / 100;
    player.autoAttackCooldown = Math.max(0.12, rules.attackInterval / (1 + haste + equipmentHaste));
    let additionalTargets = player.heroClass === "swordsman" ? 0 : (player.upgrades.multishot ?? 0);
    if (player.heroClass === "archer") {
      additionalTargets += (player.upgrades["archer-volley"] ?? 0) + (player.upgrades["archer-piercing"] ?? 0) * 2 + (player.upgrades["archer-ricochet"] ?? 0);
    } else if (player.heroClass === "mage") additionalTargets += player.upgrades["mage-chain"] ?? 0;
    const selectedTargets = targets.slice(0, 1 + additionalTargets);
    for (const [index, candidate] of selectedTargets.entries()) {
      const secondaryMultiplier = index === 0 ? 1 : player.heroClass === "mage" ? 0.6 : 0.65;
      this.damageEnemy(userId, candidate.id, this.calculateAttackDamage(player, candidate) * secondaryMultiplier);
    }
    this.combatAttackEvents.push({
      v: PROTOCOL_VERSION,
      sequence: player.attackCount,
      attackerId: player.userId,
      heroClass: player.heroClass,
      targetId: target.id,
      targetX: target.x,
      targetY: target.y,
      aim: player.aim,
      critical: player.lastAttackCritical,
      firedAt: this.elapsed,
    });
    this.combatAttackEventCount += 1;
    return target;
  }

  private updateAutoSkills(): void {
    for (const player of this.players.values()) {
      if (!player.connected || !player.alive || (!player.aiRole && player.lastInputAt < 0)) continue;
      for (const skillId of ["q", "e"] as const) {
        const cooldown = skillId === "q" ? player.qCooldown : player.eCooldown;
        if (cooldown > 0) continue;
        const target = this.autoSkillTarget(player, skillId);
        if (target) this.castSkill(player.userId, skillId, Math.atan2(target.y - player.y, target.x - player.x));
      }
    }
  }

  private autoSkillTarget(player: CorePlayer, skillId: AutoSkillId): CoreEnemy | null {
    const definition = autoSkillDefinition(player.heroClass, skillId);
    const enemies = [...this.enemies.values()];
    const rangeSquared = definition.range ** 2;
    let best: CoreEnemy | null = null;
    let bestScore = -Infinity;
    let bestDistance = Infinity;
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      const distanceSquared = (enemy.x - player.x) ** 2 + (enemy.y - player.y) ** 2;
      if (distanceSquared > rangeSquared || !this.hasPlayerLineOfSight(player, enemy)) continue;
      const distance = Math.sqrt(distanceSquared);
      const score = definition.targeting === "area" ? this.skillClusterScore(enemy, definition, enemies) : 0;
      if (score > bestScore || (score === bestScore && (distance < bestDistance
        || (distance === bestDistance && (best === null || enemy.id < best.id))))) {
        best = enemy;
        bestScore = score;
        bestDistance = distance;
      }
    }
    return best;
  }

  private skillClusterScore(
    anchor: CoreEnemy,
    definition: ReturnType<typeof autoSkillDefinition>,
    enemies: readonly CoreEnemy[],
  ): number {
    const radiusSquared = definition.radius ** 2;
    return enemies.filter((enemy) => enemy.alive
      && (enemy.x - anchor.x) ** 2 + (enemy.y - anchor.y) ** 2 <= radiusSquared).length;
  }

  castSkill(userId: string, skillId: "q" | "e" | "dash", aim: number): boolean {
    const player = this.players.get(userId);
    if (!player || !player.alive || this.phase === "lobby" || this.phase === "ended") return false;
    player.aim = aim;
    if (skillId === "dash") {
      if (player.dashCooldown > 0) return false;
      player.dashCooldown = 5;
      player.skillSequence += 1;
      player.lastSkillId = "dash";
      player.skillTargetX = player.x + Math.cos(aim) * 145;
      player.skillTargetY = player.y + Math.sin(aim) * 145;
      player.skillRadius = 0;
      this.movePlayer(player, Math.cos(aim) * 145, Math.sin(aim) * 145);
      return true;
    }
    const definition = autoSkillDefinition(player.heroClass, skillId);
    const cooldownKey = skillId === "q" ? "qCooldown" : "eCooldown";
    if (player[cooldownKey] > 0) return false;
    const anchor = this.autoSkillTarget(player, skillId);
    if (!anchor) return false;
    const cooldownReduction = Math.min(0.6, (player.upgrades["skill-haste"] ?? 0) * 0.03
      + (player.heroClass === "mage" && player.upgrades["mage-tempo"] ? 0.125 : 0));
    player[cooldownKey] = definition.cooldownSeconds * (1 - cooldownReduction);
    const skillPower = 1 + (player.upgrades["skill-power"] ?? 0) * 0.11;
    const areaMultiplier = 1 + (player.upgrades["area-power"] ?? 0) * 0.06
      + (player.heroClass === "mage" && player.upgrades["mage-nova"] ? 0.275 : 0);
    const targetX = anchor.x;
    const targetY = anchor.y;
    const range = definition.range * areaMultiplier;
    const radius = definition.radius * areaMultiplier;
    const targets = [...this.enemies.values()]
      .filter((enemy) => enemy.alive && this.hasPlayerLineOfSight(player, enemy))
      .filter((enemy) => {
        if (definition.targeting === "single") return enemy.id === anchor.id;
        if (definition.targeting === "area") return Math.hypot(enemy.x - targetX, enemy.y - targetY) <= radius;
        const along = (enemy.x - player.x) * Math.cos(aim) + (enemy.y - player.y) * Math.sin(aim);
        const across = Math.abs((enemy.x - player.x) * Math.sin(aim) - (enemy.y - player.y) * Math.cos(aim));
        return along >= 0 && along <= range && across <= radius;
      })
      .sort((left, right) => Math.hypot(left.x - player.x, left.y - player.y) - Math.hypot(right.x - player.x, right.y - player.y))
      .slice(0, definition.maxTargets);
    if (definition.dashDistance) this.movePlayer(player, Math.cos(aim) * definition.dashDistance, Math.sin(aim) * definition.dashDistance);
    player.skillSequence += 1;
    player.lastSkillId = skillId;
    player.skillTargetX = targetX;
    player.skillTargetY = targetY;
    player.skillRadius = radius;
    const baseDamage = (CLASS_COMBAT_RULES[player.heroClass].attackDamage + equipmentBonuses(player.equipment).attackBonus + augmentAttackBonus(player.upgrades))
      * definition.damageMultiplier * skillPower;
    for (const target of targets) {
      this.damageEnemy(userId, target.id, baseDamage);
      if (player.heroClass === "swordsman" && player.upgrades["swordsman-rupture"]) {
        this.vulnerableEnemies.set(target.id, { playerId: userId, expiresAt: this.elapsed + 3 });
      }
      if (player.heroClass === "archer" && player.upgrades["archer-mark"]) {
        this.markedEnemies.set(target.id, { playerId: userId, expiresAt: this.elapsed + 5 });
      }
      if (player.heroClass === "mage" && player.upgrades["mage-echo"] && target.alive) {
        this.damageEnemy(userId, target.id, baseDamage * 0.275);
      }
    }
    return true;
  }

  damageEnemy(userId: string, enemyId: string, rawDamage?: number): boolean {
    const player = this.players.get(userId);
    const enemy = this.enemies.get(enemyId);
    if (!player || !enemy || !player.alive || !enemy.alive || !this.hasPlayerLineOfSight(player, enemy)) return false;
    const damage = Math.max(1, Math.round(rawDamage ?? this.calculateAttackDamage(player, enemy)));
    enemy.hp = Math.max(0, enemy.hp - damage);
    enemy.lastHitBy = userId;
    if (enemy.behavior === "static") {
      enemy.aggroed = true;
      enemy.targetId = userId;
    }
    player.damage += damage;
    if (enemy.kind === "boss") player.bossDamage += damage;
    if (enemy.hp === 0) this.killEnemy(player, enemy);
    return true;
  }

  addTeamExperience(amount: number): readonly number[] {
    const result = addExperience({ level: this.teamLevel, xp: this.teamXp }, Math.max(0, Math.round(amount)));
    this.teamLevel = result.progress.level;
    this.teamXp = result.progress.xp;
    for (const player of this.players.values()) {
      player.level = this.teamLevel;
      for (const level of result.gainedLevels) player.pendingUpgradeLevels.push(level);
      this.activateNextDraft(player);
      this.autoChooseAiUpgrades(player);
      this.recalculateTeamPower(player);
    }
    return result.gainedLevels;
  }

  grantTeamXp(amount: number): readonly number[] {
    return this.addTeamExperience(amount);
  }

  chooseUpgrade(userId: string, draftId: string, upgradeId: string): boolean {
    const player = this.players.get(userId);
    const draft = player?.upgradeDraft;
    if (!player || !draft || draft.draftId !== draftId) return false;
    const choice = draft.choices.find((candidate) => candidate.id === upgradeId);
    if (!choice) return false;
    player.upgrades = addAugmentStack(player.upgrades, choice.id as AugmentId);
    player.upgradeDraft = null;
    this.activateNextDraft(player);
    this.recalculateTeamPower(player);
    return true;
  }

  requestTravel(userId: string, waypointIdValue: string, destinationId?: string): boolean {
    const requester = this.players.get(userId);
    const waypoint = this.waypoints.get(waypointIdValue);
    if (!requester || !requester.connected || !requester.alive || !waypoint?.active) return false;
    if (!isPlayerOnWaypoint(requester, waypoint)) return false;

    const destination = destinationId || waypoint.destinationId;
    if (!this.isAllowedDestination(waypoint, destination)) return false;
    return this.beginTravel(userId, waypoint, destination);
  }

  private beginTravel(userId: string, waypoint: CoreWaypoint, destination: string): boolean {
    const eligible = this.travelEligiblePlayers();
    if (eligible.length === 0 || eligible.some((player) => !isPlayerOnWaypoint(player, waypoint))) return false;

    if (this.travelIntent?.waypointId === waypoint.id && this.travelIntent.destinationId === destination) return true;
    this.cancelTravel();
    this.travelIntent = { requestedBy: userId, waypointId: waypoint.id, destinationId: destination, elapsed: 0 };
    waypoint.requiredPlayers = eligible.length;
    waypoint.holdingPlayers = eligible.length;
    waypoint.holdProgress = 0;
    return true;
  }

  interact(userId: string, targetId: string): boolean {
    if (this.drops.has(targetId)) return this.equip(userId, targetId);
    const waypoint = this.waypoints.get(targetId);
    if (waypoint) return this.requestTravel(userId, targetId, waypoint.destinationId);
    const door = this.doors.get(targetId);
    const player = this.players.get(userId);
    if (!door || !player || door.locked || !door.open) return false;
    const destination = player.roomId === door.fromRoomId
      ? door.toRoomId
      : player.roomId === door.toRoomId
        ? door.fromRoomId
        : null;
    if (!destination) return false;
    if (!this.canEnterRoom(player, destination)) return false;
    const center = this.roomWorldCenterOf(destination);
    player.roomId = destination;
    player.x = center.x;
    player.y = center.y;
    this.discoverRoom(destination);
    const destinationZone = this.rooms.get(destination)?.zone;
    if (destinationZone && destinationZone > this.currentZone) this.currentZone = destinationZone;
    return true;
  }

  equip(userId: string, dropId: string): boolean {
    const player = this.players.get(userId);
    const drop = this.drops.get(dropId);
    if (!player || !drop || drop.claimed || drop.ownerPlayerId !== userId || drop.roomId !== player.roomId) return false;
    this.equipItem(player, drop);
    drop.claimed = true;
    this.drops.delete(dropId);
    return true;
  }

  equipDrop(userId: string, dropId: string): boolean {
    return this.equip(userId, dropId);
  }

  recall(userId: string): boolean {
    const player = this.players.get(userId);
    if (!player || !player.connected || !player.alive || this.phase === "boss") return false;
    const source = [...this.waypoints.values()].find((waypoint) => (
      waypoint.active && isPlayerOnWaypoint(player, waypoint)
    ));
    if (!source) return false;
    const baseWaypointId = waypointId(this.startRoomId(), "start");
    if (source.id === baseWaypointId) return false;
    return this.beginTravel(userId, source, baseWaypointId);
  }

  movePlayerToRoom(userId: string, roomId: CoreRoomId, _x?: number, _y?: number): boolean {
    const player = this.players.get(userId);
    const room = this.rooms.get(roomId);
    if (!player || !room) return false;
    const center = this.roomWorldCenterOf(roomId);
    player.roomId = roomId;
    player.x = center.x;
    player.y = center.y;
    this.discoverRoom(roomId);
    this.refreshCurrentZone();
    return true;
  }

  spawnInvader(zone: ZoneId = this.currentZone, gateEnemyId?: string): CoreEnemy {
    if (this.liveInvaderCount >= this.maxLiveInvaders) {
      this.invaderCapHits += 1;
      throw new RangeError(`Live invader limit of ${this.maxLiveInvaders} reached`);
    }
    const spawnIndex = this.invaderSerial;
    const requestedGate = gateEnemyId ? this.enemies.get(gateEnemyId) : null;
    const explicitGate = requestedGate?.kind === "gate" && requestedGate.alive ? requestedGate : null;
    const authoredGate = this.authoredWorld ? explicitGate ?? this.authoredSpawnGate(zone) : null;
    const authoredPath = authoredGate
      ? this.shortestRoomPath(authoredGate.roomId, this.authoredWorld!.baseRoomId)
      : null;
    const authoredPosition = authoredGate ? this.roomWorldCenterOf(authoredGate.roomId) : null;
    const invader = createInvaderEnemy(
      this.options.seed,
      zone,
      this.invaderSerial,
      this.maps,
      this.options.difficulty,
      authoredGate && authoredPath && authoredPosition
        ? { roomId: authoredGate.roomId, path: authoredPath, position: authoredPosition }
        : undefined,
    );
    const gate = authoredGate ?? explicitGate ?? this.livingGateInZone(zone);
    if (gate) {
      const spawn = this.invaderSpawnPosition(zone, gate, spawnIndex);
      invader.x = spawn.x;
      invader.y = spawn.y;
      invader.spawnX = spawn.x;
      invader.spawnY = spawn.y;
    }
    this.invaderSerial += 1;
    this.enemies.set(invader.id, invader);
    this.invaderNavigation.set(invader.id, this.createInvaderNavigation(invader));
    this.replanInvader(invader, this.invaderNavigation.get(invader.id) as InvaderNavigation, true);
    return invader;
  }

  startBoss(): boolean {
    if (this.phase === "ended" || this.day < 3 || this.hasLivingAuthoredGate()) return false;
    this.enterBossEncounter();
    return true;
  }

  finish(result: CoreResult, reason: string): void {
    if (this.phase === "ended") return;
    this.phase = "ended";
    this.phaseRemaining = 0;
    this.result = result;
    this.resultReason = reason;
    this.cancelTravel();
  }

  equipmentSummary(userId: string): CoreEquipmentBonuses | null {
    const player = this.players.get(userId);
    return player ? equipmentBonuses(player.equipment) : null;
  }

  combatStats(userId: string): CoreCombatStats | null {
    const player = this.players.get(userId);
    if (!player) return null;
    const rules = CLASS_COMBAT_RULES[player.heroClass];
    const equipment = equipmentBonuses(player.equipment);
    const haste = (player.upgrades.haste ?? 0) * 0.06 + equipment.attackSpeedBonus / 100;
    const rangeMultiplier = 1 + (player.upgrades["area-power"] ?? 0) * 0.06
      + (player.heroClass === "swordsman" ? (player.upgrades.multishot ?? 0) * 0.1 : 0);
    const bladeRange = player.heroClass === "swordsman" && player.upgrades["swordsman-blade"] ? 240 : 0;
    return {
      attackDamage: rules.attackDamage + equipment.attackBonus + augmentAttackBonus(player.upgrades),
      defense: equipment.defenseBonus,
      criticalChance: (player.upgrades.precision ?? 0) * 6,
      criticalDamage: 150 + (player.upgrades.ferocity ?? 0) * 20,
      attacksPerSecond: (1 + haste) / rules.attackInterval,
      attackRange: Math.max(rules.attackRange * rangeMultiplier, bladeRange),
      moveSpeed: rules.speed,
    };
  }

  private transition(phase: "day" | "night" | "standby"): void {
    this.phase = phase;
    this.phaseRemaining = durations[this.options.mode][phase];
    this.invaderSpawnAccumulator = 0;
    this.invaderWaveIndex = 0;
  }

  private calculateAttackDamage(player: CorePlayer, enemy: CoreEnemy): number {
    const rules = CLASS_COMBAT_RULES[player.heroClass];
    let damage = rules.attackDamage + equipmentBonuses(player.equipment).attackBonus + augmentAttackBonus(player.upgrades);
    const criticalChance = (player.upgrades.precision ?? 0) * 0.03;
    const critical = deterministicCombatRoll(this.options.seed, player.userId, player.attackCount) < criticalChance;
    player.lastAttackCritical = critical;
    if (critical) {
      damage *= 1.5 + (player.upgrades.ferocity ?? 0) * 0.1;
    }
    const momentumStacks = player.upgrades.momentum ?? 0;
    if (momentumStacks > 0) damage *= 1 + Math.min(0.1 * momentumStacks, player.consecutiveHits * 0.02 * momentumStacks);
    if (["hidden", "gate", "boss"].includes(enemy.kind)) damage *= 1 + (player.upgrades["boss-hunter"] ?? 0) * 0.06;
    if (player.heroClass === "swordsman" && player.upgrades["swordsman-execution"] && enemy.hp / enemy.maxHp <= 0.3) {
      damage *= 1.3;
    }
    if (player.heroClass === "archer" && player.upgrades["archer-sniper"]) {
      const distance = Math.hypot(enemy.x - player.x, enemy.y - player.y);
      damage *= 1 + Math.min(0.275, Math.max(0, (distance - 180) / 280) * 0.275);
    }
    if (player.heroClass === "swordsman" && player.upgrades["swordsman-combo"] && player.attackCount % 3 === 0) damage *= 1.5;
    if (player.heroClass === "mage" && player.upgrades["mage-overcharge"] && player.attackCount % 4 === 0) damage *= 1.6;
    if (this.vulnerableEnemies.get(enemy.id)?.playerId === player.userId && (this.vulnerableEnemies.get(enemy.id)?.expiresAt ?? 0) > this.elapsed) damage *= 1.075;
    if (this.markedEnemies.get(enemy.id)?.playerId === player.userId && (this.markedEnemies.get(enemy.id)?.expiresAt ?? 0) > this.elapsed) damage *= 1.125;
    return Math.max(1, Math.round(damage));
  }

  private enemiesInAttackCone(player: CorePlayer, range: number, coneHalfAngle: number): CoreEnemy[] {
    const rangeSquared = range * range;
    const candidates: Array<{ enemy: CoreEnemy; distanceSquared: number }> = [];
    for (const enemy of this.enemies.values()) {
      if (!enemy.alive) continue;
      const dx = enemy.x - player.x;
      const dy = enemy.y - player.y;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > rangeSquared) continue;
      const relativeAngle = Math.atan2(dy, dx) - player.aim;
      const angularError = Math.abs(Math.atan2(Math.sin(relativeAngle), Math.cos(relativeAngle)));
      if (angularError > coneHalfAngle || !this.hasPlayerLineOfSight(player, enemy)) continue;
      candidates.push({ enemy, distanceSquared });
    }
    candidates.sort((left, right) => left.distanceSquared - right.distanceSquared
      || left.enemy.id.localeCompare(right.enemy.id));
    return candidates.map(({ enemy }) => enemy);
  }

  private hasPlayerLineOfSight(player: CorePlayer, enemy: CoreEnemy): boolean {
    if (enemy.roomId === player.roomId) return true;
    if (this.authoredWorld) {
      return isWalkableLine(this.authoredWalkable(), player.x, player.y, enemy.x, enemy.y);
    }
    const playerRoom = this.rooms.get(player.roomId);
    const enemyRoom = this.rooms.get(enemy.roomId);
    const zoneWorld = playerRoom ? this.zoneWorlds.get(playerRoom.zone) : null;
    return Boolean(
      playerRoom
      && enemyRoom?.zone === playerRoom.zone
      && zoneWorld
      && isWalkableLine(zoneWorld.rects, player.x, player.y, enemy.x, enemy.y)
    );
  }

  private killEnemy(killer: CorePlayer, enemy: CoreEnemy): void {
    enemy.alive = false;
    enemy.hp = 0;
    enemy.aggroed = false;
    enemy.targetId = null;
    enemy.patternPhase = "idle";
    enemy.patternRemaining = 0;
    enemy.respawnRemaining = enemy.kind === "static" ? STATIC_RESPAWN_SECONDS[this.options.mode] : null;
    killer.kills += 1;
    this.gold += enemy.goldReward;
    if (enemy.xpReward > 0) this.addTeamExperience(enemy.xpReward);

    if (enemy.kind === "gate") {
      killer.gatesDestroyed += 1;
      this.unlockGateWaypoint(enemy.spawnRoomId);
    } else if (enemy.kind === "hidden") {
      this.rewardHiddenRoom(enemy.spawnRoomId);
    } else if (enemy.kind === "boss") {
      const room = this.rooms.get(this.bossRoomId());
      if (room) room.cleared = true;
      this.finish("victory", "마왕을 쓰러뜨리고 왕국을 지켜냈습니다.");
    }

    const room = this.rooms.get(enemy.spawnRoomId);
    if (room && ![...this.enemies.values()].some((candidate) =>
      candidate.alive && candidate.spawnRoomId === room.id && candidate.kind !== "invader")) {
      room.cleared = true;
    }
  }

  private rewardHiddenRoom(roomId: CoreRoomId): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const drops = rollPartyHiddenDrops({
      runSeed: this.options.seed,
      zone: room.zone,
      hiddenRoomId: roomId,
      dropIndex: this.hiddenDropSerial,
      playerIds: [...this.players.keys()].sort(),
    });
    this.hiddenDropSerial += 1;
    for (const item of drops) {
      const player = this.players.get(item.ownerPlayerId);
      if (!player) continue;
      if (player.aiRole && item.specialOptionCount === 0) {
        const recipient = [...this.players.values()]
          .filter((candidate) => !candidate.aiRole && candidate.alive)
          .sort((left, right) => equipmentPower(left.equipment[item.slot]) - equipmentPower(right.equipment[item.slot]))[0];
        if (recipient && shouldAiYieldEquipment(item, recipient.equipment[item.slot])) {
          this.placeDrop({ ...item, id: `${item.id}:gift:${recipient.userId}`, ownerPlayerId: recipient.userId }, roomId);
          continue;
        }
      }
      const current = player.equipment[item.slot];
      if (equipmentPower(item) > equipmentPower(current)) this.equipItem(player, item);
      else this.placeDrop(item, roomId);
    }
  }

  private placeDrop(item: PersonalHiddenDrop, roomId: CoreRoomId): void {
    const room = this.rooms.get(roomId);
    const center = room ? this.roomWorldCenterOf(room.id) : { x: ROOM_WIDTH / 2, y: ROOM_HEIGHT / 2 };
    this.drops.set(item.id, { ...item, roomId, x: center.x, y: center.y, claimed: false });
  }

  private equipItem(player: CorePlayer, item: PersonalHiddenDrop): void {
    const previousMaxHp = player.maxHp;
    player.equipment[item.slot as EquipmentSlot] = item;
    player.maxHp = CLASS_COMBAT_RULES[player.heroClass].hp + equipmentBonuses(player.equipment).maxHpBonus;
    player.hp = Math.min(player.maxHp, Math.max(1, player.hp + (player.maxHp - previousMaxHp)));
    this.recalculateTeamPower(player);
  }

  private recalculateTeamPower(player: CorePlayer): void {
    const equipmentScore = Object.values(player.equipment).reduce((sum, item) => sum + equipmentPower(item), 0);
    const augmentScore = Object.values(player.upgrades).reduce<number>((sum, stacks) => sum + (stacks ?? 0) * 10, 0);
    player.teamPower = CLASS_COMBAT_RULES[player.heroClass].power
      + (player.level - 1) * 12
      + equipmentScore
      + augmentScore;
  }

  private activateNextDraft(player: CorePlayer): void {
    if (player.upgradeDraft || player.pendingUpgradeLevels.length === 0) return;
    const level = player.pendingUpgradeLevels.shift() as number;
    const draftIndex = player.draftIndex;
    const choices = createAugmentDraft({
      runSeed: this.options.seed,
      playerId: player.userId,
      heroClass: player.heroClass,
      level,
      stacks: player.upgrades,
      draftIndex,
    });
    player.draftIndex += 1;
    player.upgradeDraft = {
      draftId: makeDraftId(this.options.seed, player.userId, level, draftIndex),
      level,
      active: true,
      expiresAt: 0,
      choices,
    };
  }

  private autoChooseAiUpgrades(player: CorePlayer): void {
    if (!player.aiRole) return;
    while (player.upgradeDraft) {
      const choice = [...player.upgradeDraft.choices].sort((left, right) => (
        aiAugmentScore(player.heroClass, right.id) - aiAugmentScore(player.heroClass, left.id)
        || left.id.localeCompare(right.id)
      ))[0];
      if (!choice) break;
      player.upgrades = addAugmentStack(player.upgrades, choice.id as AugmentId);
      player.upgradeDraft = null;
      this.activateNextDraft(player);
    }
    this.recalculateTeamPower(player);
  }

  private discoverRoom(roomId: CoreRoomId): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.discovered = true;
    this.discoveredRooms.add(roomId);
    if (room.kind === "resource" && !this.resourceAccumulators.has(roomId)) {
      this.resourceAccumulators.set(roomId, 0);
    }
    if (roomId === this.bossRoomId()) return;
    for (const waypoint of this.waypoints.values()) {
      if (waypoint.roomId === roomId && (waypoint.kind === "start" || waypoint.kind === "central")) {
        waypoint.active = true;
      }
    }
  }

  private unlockGateWaypoint(gateRoomId: CoreRoomId): void {
    const gateWaypoint = [...this.waypoints.values()].find((waypoint) => waypoint.roomId === gateRoomId);
    if (!gateWaypoint) return;
    gateWaypoint.active = true;
    const next = this.waypoints.get(gateWaypoint.destinationId);
    if (next) next.active = true;
  }

  private isAllowedDestination(source: CoreWaypoint, destinationId: string): boolean {
    if (source.kind === "gate" || source.kind === "boss") return destinationId === source.destinationId;
    const destination = this.waypoints.get(destinationId);
    return Boolean(destination?.active && destination.id !== source.id);
  }

  private travelEligiblePlayers(): CorePlayer[] {
    return [...this.players.values()].filter((player) => player.connected && player.alive && !player.aiRole);
  }

  private updateTravel(delta: number): void {
    const intent = this.travelIntent;
    if (!intent) return;
    const waypoint = this.waypoints.get(intent.waypointId);
    const eligible = this.travelEligiblePlayers();
    const holding = waypoint ? eligible.filter((player) => isPlayerOnWaypoint(player, waypoint)) : [];
    if (!waypoint?.active || eligible.length === 0 || holding.length !== eligible.length) {
      this.cancelTravel();
      return;
    }
    intent.elapsed += delta;
    waypoint.requiredPlayers = eligible.length;
    waypoint.holdingPlayers = holding.length;
    waypoint.holdProgress = Math.min(1, intent.elapsed / WAYPOINT_HOLD_SECONDS);
    if (intent.elapsed + SIMULATION_EPSILON >= WAYPOINT_HOLD_SECONDS) {
      const followers = [...this.players.values()].filter((player) => player.alive && player.aiRole === "follower");
      this.completeTravel(intent.destinationId, [...eligible, ...followers]);
    }
  }

  private completeTravel(destinationId: string, players: readonly CorePlayer[]): void {
    if (destinationId === this.bossRoomId()) {
      const bossRoomId = this.bossRoomId();
      const boss = this.roomRectOf(bossRoomId);
      for (const player of players) {
        player.roomId = bossRoomId;
        player.x = boss.x + boss.width / 2;
        player.y = boss.y + boss.height * 0.72;
      }
      this.discoverRoom(bossRoomId);
      this.currentZone = 3;
      this.enterBossEncounter();
      this.cancelTravel();
      return;
    }

    const destination = this.waypoints.get(destinationId);
    if (!destination?.active) {
      this.cancelTravel();
      return;
    }
    if (destination.zone > this.currentZone && this.hasLivingGateInZone(this.currentZone)) {
      for (const player of players) this.pushZoneGateWarning(player.userId, this.currentZone);
      this.cancelTravel();
      return;
    }
    for (const player of players) {
      player.roomId = destination.roomId;
      player.x = destination.x;
      player.y = destination.y;
    }
    this.discoverRoom(destination.roomId);
    if (destination.zone > this.currentZone) this.currentZone = destination.zone;
    this.cancelTravel();
  }

  private cancelTravel(): void {
    if (this.travelIntent) {
      const waypoint = this.waypoints.get(this.travelIntent.waypointId);
      if (waypoint) {
        waypoint.requiredPlayers = 0;
        waypoint.holdingPlayers = 0;
        waypoint.holdProgress = 0;
      }
    }
    this.travelIntent = null;
  }

  private enterBossEncounter(): void {
    this.phase = "boss";
    this.phaseRemaining = 0;
    if (![...this.enemies.values()].some((enemy) => enemy.kind === "boss" && enemy.alive)) {
      const boss = createBossEnemy(this.options.seed, this.options.difficulty);
      if (this.authoredWorld) {
        const roomId = this.authoredWorld.bossRoomId;
        const center = this.roomWorldCenterOf(roomId);
        boss.roomId = roomId;
        boss.spawnRoomId = roomId;
        boss.x = center.x;
        boss.y = center.y;
        boss.spawnX = center.x;
        boss.spawnY = center.y;
      }
      this.enemies.set(boss.id, boss);
    }
  }

  private updateStaticEnemies(delta: number): void {
    for (const enemy of this.enemies.values()) {
      if (!enemy.alive || enemy.kind !== "static") continue;
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - delta);
      const target = this.nearestPlayerInRoom(enemy.roomId, enemy.x, enemy.y, 560);
      if (!target) {
        enemy.aggroed = false;
        enemy.targetId = null;
        this.moveEnemyToward(enemy, enemy.spawnX, enemy.spawnY, delta);
        continue;
      }
      enemy.aggroed = true;
      enemy.targetId = target.userId;
      const distance = Math.hypot(target.x - enemy.x, target.y - enemy.y);
      if (distance > enemy.attackRange) this.moveEnemyToward(enemy, target.x, target.y, delta);
      else if (enemy.attackCooldown <= 0) {
        enemy.attackSequence += 1;
        enemy.attackCooldown = 0.9;
        this.damagePlayer(target, enemy.damage);
      }
    }
  }

  private updatePatternEnemies(delta: number): void {
    for (const enemy of this.enemies.values()) {
      if (!enemy.alive || !["hidden", "gate", "boss"].includes(enemy.kind)) continue;
      const tier = enemy.kind === "boss" ? "boss" : enemy.kind === "hidden" ? "hidden" : "gate";
      const config = enemyPatternConfig(tier);
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - delta);
      const target = this.nearestPlayerInRoom(enemy.roomId, enemy.x, enemy.y, Number.POSITIVE_INFINITY);
      if (!target) {
        enemy.targetId = null;
        enemy.patternPhase = "idle";
        enemy.patternRemaining = 0;
        continue;
      }
      enemy.aggroed = true;
      enemy.targetId = target.userId;
      if (enemy.patternPhase === "idle") {
        if (enemy.attackCooldown > 0) continue;
        enemy.patternKind = enemy.patternIndex % 2 === 0 ? "fan" : "floor";
        enemy.patternPhase = "telegraph";
        enemy.patternRemaining = config.telegraphSeconds;
        continue;
      }
      enemy.patternRemaining = Math.max(0, enemy.patternRemaining - delta);
      if (enemy.patternRemaining > SIMULATION_EPSILON) continue;
      this.resolveEnemyPattern(enemy);
      enemy.patternPhase = "idle";
      enemy.patternIndex += 1;
      enemy.attackCooldown = config.cooldownSeconds;
    }
  }

  private resolveEnemyPattern(enemy: CoreEnemy): void {
    const tier = enemy.kind === "boss" ? "boss" : enemy.kind === "hidden" ? "hidden" : "gate";
    const config = enemyPatternConfig(tier);
    for (const player of this.players.values()) {
      if (!player.alive || player.roomId !== enemy.roomId) continue;
      let hit = false;
      if (enemy.patternKind === "floor") {
        hit = enemyFloorPatternCircles(enemy.x, enemy.y, enemy.patternIndex, tier)
          .some((circle) => Math.hypot(player.x - circle.x, player.y - circle.y) <= circle.radius);
      } else {
        const dx = player.x - enemy.x;
        const dy = player.y - enemy.y;
        const distance = Math.hypot(dx, dy);
        hit = distance <= config.range && enemyFanPatternAngles(enemy.patternIndex, tier).some((angle) => {
          const forward = dx * Math.cos(angle) + dy * Math.sin(angle);
          const perpendicular = Math.abs(-dx * Math.sin(angle) + dy * Math.cos(angle));
          return forward >= 0 && forward <= config.range && perpendicular <= 18;
        });
      }
      if (hit) this.damagePlayer(player, enemy.damage);
    }
  }

  private updateStaticRespawns(delta: number): void {
    for (const enemy of this.enemies.values()) {
      if (enemy.kind !== "static" || enemy.alive || enemy.respawnRemaining === null) continue;
      enemy.respawnRemaining = Math.max(0, enemy.respawnRemaining - delta);
      if (enemy.respawnRemaining > SIMULATION_EPSILON) continue;
      enemy.alive = true;
      enemy.hp = enemy.maxHp;
      enemy.roomId = enemy.spawnRoomId;
      enemy.x = enemy.spawnX;
      enemy.y = enemy.spawnY;
      enemy.aggroed = false;
      enemy.targetId = null;
      enemy.lastHitBy = null;
      enemy.attackCooldown = 0;
      enemy.patternKind = "fan";
      enemy.patternPhase = "idle";
      enemy.patternRemaining = 0;
      enemy.patternIndex = 0;
      enemy.attackSequence = 0;
      enemy.transformRevision += 1;
      enemy.lastMoveSpeed = 0;
      enemy.respawnRemaining = null;
      const room = this.rooms.get(enemy.spawnRoomId);
      if (room) room.cleared = false;
    }
  }

  private damagePlayer(player: CorePlayer, rawDamage: number): void {
    const defense = equipmentBonuses(player.equipment).defenseBonus;
    player.hp = Math.max(0, player.hp - Math.max(1, Math.round(rawDamage - defense)));
    if (player.hp > 0) return;
    const startRoomId = this.startRoomId();
    const startCenter = this.roomWorldCenterOf(startRoomId);
    player.hp = player.maxHp;
    player.alive = true;
    player.roomId = startRoomId;
    player.x = startCenter.x;
    player.y = startCenter.y;
    player.aim = 0;
    player.inputX = 0;
    player.inputY = 0;
    player.lastButtons = 0;
    player.lastAttackTargetId = null;
    player.consecutiveHits = 0;
    player.deaths += 1;
    this.discoverRoom(startRoomId);
  }

  private updateInvaders(delta: number): void {
    this.invaderSimulationTick += 1;
    const playerTargets = this.assignInvaderPlayerTargets();
    const playerRooms = new Set([...this.players.values()]
      .filter((player) => player.alive && player.connected)
      .map((player) => player.roomId));
    const warmRooms = this.invaderWarmRooms(playerRooms);
    let hotCount = 0;
    let warmCount = 0;
    let coldCount = 0;
    for (const enemy of this.enemies.values()) {
      if (!enemy.alive || enemy.behavior !== "invader") continue;
      const navigation = this.invaderNavigation.get(enemy.id) ?? this.createInvaderNavigation(enemy);
      this.invaderNavigation.set(enemy.id, navigation);
      navigation.accumulatedDelta = Math.min(0.1, navigation.accumulatedDelta + delta);

      const playerTarget = playerTargets.get(enemy.id) ?? null;
      const playerDistance = playerTarget && playerTarget.roomId === enemy.roomId
        ? Math.hypot(playerTarget.x - enemy.x, playerTarget.y - enemy.y)
        : Number.POSITIVE_INFINITY;
      const baseDestination = this.invaderBaseDestination(enemy);
      const baseCenter = enemy.roomId === baseDestination ? this.roomWorldCenterOf(baseDestination) : null;
      const baseDistance = baseCenter ? Math.hypot(baseCenter.x - enemy.x, baseCenter.y - enemy.y) : Number.POSITIVE_INFINITY;
      const hot = playerDistance <= Math.max(INVADER_COMBAT_RADIUS, enemy.attackRange + enemy.speed * 0.1)
        || baseDistance <= Math.max(INVADER_COMBAT_RADIUS, INVADER_BASE_RADIUS + enemy.speed * 0.1);
      const warm = !hot && (Boolean(playerTarget) || playerRooms.has(enemy.roomId) || warmRooms.has(enemy.roomId));
      if (hot) hotCount += 1;
      else if (warm) warmCount += 1;
      else coldCount += 1;
      const divisor = hot ? 1 : warm ? this.warmInvaderDivisor : this.coldInvaderDivisor;
      if (divisor > 1 && (this.invaderSimulationTick + navigation.cohort) % divisor !== 0) continue;
      const stepDelta = navigation.accumulatedDelta;
      navigation.accumulatedDelta = 0;
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - stepDelta);
      navigation.retryRemaining = Math.max(0, navigation.retryRemaining - stepDelta);
      const targetId = playerTarget?.userId ?? "base";
      const targetRoomId = playerTarget?.roomId ?? this.invaderBaseDestination(enemy);
      if (enemy.targetId !== targetId || navigation.targetRoomId !== targetRoomId) {
        enemy.targetId = targetId;
        navigation.targetRoomId = targetRoomId;
        if (playerTarget?.roomId === enemy.roomId) {
          enemy.path = [enemy.roomId];
          enemy.pathIndex = 0;
          navigation.retryRemaining = 0;
          navigation.portalPassed = false;
          navigation.corridorWaypointIndex = 0;
          navigation.corridorConnectionId = null;
          this.pendingInvaderReplans.delete(enemy.id);
          this.resetInvaderStall(enemy, navigation);
        } else {
          this.scheduleInvaderReplan(enemy.id, true);
          continue;
        }
      }

      if (enemy.path[enemy.pathIndex] !== enemy.roomId && navigation.retryRemaining <= 0) {
        this.scheduleInvaderReplan(enemy.id, false);
        continue;
      }

      if (playerTarget && playerTarget.roomId === enemy.roomId) {
        const distance = Math.hypot(playerTarget.x - enemy.x, playerTarget.y - enemy.y);
        if (distance <= enemy.attackRange) {
          this.resetInvaderStall(enemy, navigation);
          if (enemy.attackCooldown <= 0) {
            enemy.attackSequence += 1;
            enemy.attackCooldown = 1;
            this.damagePlayer(playerTarget, enemy.damage);
          }
        } else {
          this.moveInvaderWorld(enemy, navigation, playerTarget.x, playerTarget.y, stepDelta, null);
        }
        continue;
      }

      if (enemy.pathIndex + 1 < enemy.path.length) {
        const nextRoomId = enemy.path[enemy.pathIndex + 1] as CoreRoomId;
        if (!this.isInvaderEdgeTraversable(enemy.roomId, nextRoomId, navigation)) {
          this.scheduleInvaderReplan(enemy.id, false);
          continue;
        }
        this.moveInvaderThroughConnection(enemy, navigation, nextRoomId, stepDelta);
        continue;
      }

      if (enemy.targetId === "base") {
        const baseTarget = this.roomWorldCenterOf(this.invaderBaseDestination(enemy));
        const distance = Math.hypot(baseTarget.x - enemy.x, baseTarget.y - enemy.y);
        if (distance > INVADER_BASE_RADIUS) {
          this.moveInvaderWorld(enemy, navigation, baseTarget.x, baseTarget.y, stepDelta, null);
        } else if (this.rooms.get(enemy.roomId)?.zone === 1) {
          this.damageBase(enemy.damage);
          enemy.alive = false;
          this.invaderNavigation.delete(enemy.id);
        } else {
          this.transferInvaderToPreviousZone(enemy, navigation);
        }
      } else if (navigation.retryRemaining <= 0) {
        this.scheduleInvaderReplan(enemy.id, false);
      }
    }
    this.releasePendingInvaderReplans(playerTargets, playerRooms);
    this.invaderTierCounts = { hot: hotCount, warm: warmCount, cold: coldCount };
  }

  private updateInvaderSpawning(delta: number): void {
    this.pruneInvaderWaveQueue();
    const spawnGate = this.authoredWorld ? this.authoredSpawnGate(this.currentZone) : this.livingGateInZone(this.currentZone);
    if (!spawnGate) {
      this.invaderSpawnAccumulator = 0;
      this.invaderSpawnReleaseAccumulator = 0;
      this.invaderWaveIndex = 0;
      this.invaderWaveQueue.length = 0;
      return;
    }
    this.invaderSpawnReleaseAccumulator += delta;
    while (this.invaderSpawnReleaseAccumulator + SIMULATION_EPSILON >= INVADER_MICRO_SPAWN_INTERVAL_SECONDS) {
      this.invaderSpawnReleaseAccumulator -= INVADER_MICRO_SPAWN_INTERVAL_SECONDS;
      this.releaseOldestInvaderWave();
    }
    if (this.phase !== "day" && this.phase !== "night") return;
    const isNight = this.phase === "night";
    const waveCount = isNight ? INVADER_NIGHT_WAVES : INVADER_DAY_WAVES;
    const phaseDuration = durations[this.options.mode][this.phase];
    const interval = phaseDuration / waveCount;
    this.invaderSpawnAccumulator += delta;
    if (this.invaderSpawnAccumulator + SIMULATION_EPSILON < interval) return;
    this.invaderSpawnAccumulator = Math.max(0, this.invaderSpawnAccumulator - interval);
    const count = isNight ? 3 + this.invaderWaveIndex * 2 : this.invaderWaveIndex + 1;
    this.invaderWaveIndex = Math.min(waveCount, this.invaderWaveIndex + 1);
    this.enqueueInvaderWave(spawnGate.id, this.currentZone, count);
  }

  private enqueueInvaderWave(gateEnemyId: string, zone: ZoneId, count: number): void {
    const available = Math.max(0, MAX_PENDING_INVADERS - this.pendingInvaderCount);
    const accepted = Math.min(Math.max(0, Math.floor(count)), available);
    if (accepted > 0) this.invaderWaveQueue.push({ gateEnemyId, zone, remaining: accepted, queuedAt: this.elapsed });
    if (accepted < count) this.invaderCapHits += 1;
  }

  private releaseOldestInvaderWave(): void {
    const batch = this.invaderWaveQueue[0];
    if (!batch) return;
    const gate = this.enemies.get(batch.gateEnemyId);
    if (!gate?.alive || gate.kind !== "gate") return;
    const available = Math.max(0, this.maxLiveInvaders - this.liveInvaderCount);
    const requestedCount = Math.min(batch.remaining, available, INVADER_MICRO_SPAWN_COUNT);
    if (available < batch.remaining && requestedCount === available) this.invaderCapHits += 1;
    let spawnCount = 0;
    while (spawnCount < requestedCount) {
      const spawn = this.invaderSpawnPosition(batch.zone, gate, this.invaderSerial);
      const congested = [...this.enemies.values()].some((enemy) => (
        enemy.alive
        && enemy.behavior === "invader"
        && Math.hypot(enemy.x - spawn.x, enemy.y - spawn.y) < ACTOR_COLLISION_RADIUS * 2 + 4
      ));
      if (congested) break;
      this.spawnInvader(batch.zone, batch.gateEnemyId);
      this.microSpawnedInvaders += 1;
      spawnCount += 1;
    }
    batch.remaining -= spawnCount;
    if (batch.remaining <= 0) this.invaderWaveQueue.shift();
  }

  private invaderSpawnPosition(zone: ZoneId, gate: CoreEnemy, spawnIndex: number): { x: number; y: number } {
    const roomCenter = this.roomWorldCenterOf(gate.roomId);
    const dx = roomCenter.x - gate.x;
    const dy = roomCenter.y - gate.y;
    const distance = Math.hypot(dx, dy) || 1;
    const world = this.zoneWorlds.get(zone);
    const roomRect = this.roomRectOf(gate.roomId);
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
      const gate = this.enemies.get(this.invaderWaveQueue[index]!.gateEnemyId);
      if (!gate || gate.kind !== "gate" || !gate.alive || this.invaderWaveQueue[index]!.zone !== this.currentZone) {
        this.invaderWaveQueue.splice(index, 1);
      }
    }
  }

  private retireInactiveInvaders(): void {
    for (const [id, enemy] of this.enemies) {
      if (enemy.behavior !== "invader" || enemy.alive) continue;
      this.enemies.delete(id);
      this.invaderNavigation.delete(id);
      this.pendingInvaderReplans.delete(id);
      this.vulnerableEnemies.delete(id);
      this.markedEnemies.delete(id);
      this.retiredInvaders += 1;
    }
  }

  private livingGateInZone(zone: ZoneId): CoreEnemy | null {
    return [...this.enemies.values()].find((enemy) => (
      enemy.kind === "gate" && enemy.alive && this.rooms.get(enemy.roomId)?.zone === zone
    )) ?? null;
  }

  private createInvaderNavigation(enemy: CoreEnemy): InvaderNavigation {
    return {
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
    };
  }

  private assignInvaderPlayerTargets(): Map<string, CorePlayer> {
    const result = new Map<string, CorePlayer>();
    for (const enemy of this.enemies.values()) {
      if (!enemy.alive || enemy.behavior !== "invader") continue;
      const enemyZone = this.rooms.get(enemy.roomId)?.zone;
      let selected: CorePlayer | null = null;
      let selectedDistanceSquared = Number.POSITIVE_INFINITY;
      for (const player of this.players.values()) {
        if (!player.alive || !player.connected || this.rooms.get(player.roomId)?.zone !== enemyZone) continue;
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
      if (selected) result.set(enemy.id, selected);
    }
    return result;
  }

  private invaderWarmRooms(playerRooms: ReadonlySet<CoreRoomId>): ReadonlySet<CoreRoomId> {
    const key = [...playerRooms].sort().join("|");
    if (this.warmRoomCache?.key === key) return this.warmRoomCache.rooms;
    const visited = new Set<CoreRoomId>(playerRooms);
    let frontier = [...playerRooms];
    for (let depth = 0; depth < 2; depth += 1) {
      const next: CoreRoomId[] = [];
      for (const roomId of frontier) {
        for (const connected of this.rooms.get(roomId)?.connections ?? []) {
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
    if (this.authoredWorld) return this.authoredWorld.baseRoomId;
    const zone = this.rooms.get(enemy.roomId)?.zone ?? 1;
    return this.maps.zones[zone - 1].startRoomId;
  }

  private scheduleInvaderReplan(enemyId: string, allowRandom: boolean): void {
    const previous = this.pendingInvaderReplans.get(enemyId) ?? false;
    this.pendingInvaderReplans.set(enemyId, previous || allowRandom);
  }

  private releasePendingInvaderReplans(
    playerTargets: ReadonlyMap<string, CorePlayer>,
    playerRooms: ReadonlySet<CoreRoomId>,
  ): void {
    if (this.pendingInvaderReplans.size === 0) return;
    const candidates = [...this.pendingInvaderReplans.entries()]
      .map(([enemyId, allowRandom]) => {
        const enemy = this.enemies.get(enemyId);
        const navigation = this.invaderNavigation.get(enemyId);
        if (!enemy?.alive || enemy.behavior !== "invader" || !navigation) {
          this.pendingInvaderReplans.delete(enemyId);
          return null;
        }
        const target = playerTargets.get(enemyId);
        const combatPriority = target?.roomId === enemy.roomId || playerRooms.has(enemy.roomId);
        const blockedPriority = navigation.blockedEdge !== null && navigation.blockedUntil > this.elapsed;
        return { enemy, navigation, allowRandom, priority: combatPriority ? 0 : blockedPriority ? 1 : 2 };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
      .sort((left, right) => left.priority - right.priority || left.enemy.id.localeCompare(right.enemy.id));

    for (const candidate of candidates.slice(0, INVADER_REPLAN_BUDGET_PER_TICK)) {
      this.pendingInvaderReplans.delete(candidate.enemy.id);
      this.replanInvader(candidate.enemy, candidate.navigation, candidate.allowRandom);
      this.completedInvaderReplans += 1;
    }
  }

  private replanInvader(enemy: CoreEnemy, navigation: InvaderNavigation, allowRandom: boolean): void {
    this.pendingInvaderReplans.delete(enemy.id);
    const destination = enemy.targetId && enemy.targetId !== "base"
      ? this.players.get(enemy.targetId)?.roomId
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
    const random = createSeededRandom(`${this.options.seed}:${enemy.id}:${navigation.replanSequence}`);
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
    const blocked = navigation.blockedEdge && navigation.blockedUntil > this.elapsed;
    if (!blocked) {
      const key = `invader:${this.doorTopologyKey()}:${from}>${destination}`;
      const cached = this.routeCache.get(key);
      if (cached) return [...cached];
      const path = this.weightedRoomPath(from, destination, (current, next) => (
        this.isInvaderEdgeTraversable(current, next, navigation)
      ));
      if (path) this.routeCache.set(key, path);
      return path;
    }
    return this.weightedRoomPath(from, destination, (current, next) => (
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
      for (const next of [...(this.rooms.get(current)?.connections ?? [])].sort()) {
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
    const edge = this.invaderEdgeKey(from, to);
    if (navigation.blockedEdge === edge && navigation.blockedUntil > this.elapsed) return false;
    const fromRoom = this.rooms.get(from);
    const toRoom = this.rooms.get(to);
    if (!fromRoom || !toRoom || (!this.authoredWorld && fromRoom.zone !== toRoom.zone) || !fromRoom.connections.includes(to)) return false;
    const door = this.doors.get(doorId(from as RoomId, to as RoomId));
    return Boolean(door?.open && !door.locked);
  }

  private invaderEdgeKey(from: CoreRoomId, to: CoreRoomId): string {
    return [from, to].sort().join("|");
  }

  private moveInvaderThroughConnection(
    enemy: CoreEnemy,
    navigation: InvaderNavigation,
    nextRoomId: CoreRoomId,
    delta: number,
  ): void {
    const room = this.rooms.get(enemy.roomId);
    const nextRoom = this.rooms.get(nextRoomId);
    if (!room || !nextRoom) {
      this.scheduleInvaderReplan(enemy.id, false);
      return;
    }
    const authoredConnection = this.authoredConnectionsByEdge.get(this.invaderEdgeKey(enemy.roomId, nextRoomId));
    const corridor = authoredConnection ? null : corridorRectBetween(
      { x: room.gridX, y: room.gridY },
      { x: nextRoom.gridX, y: nextRoom.gridY },
    );
    if (!corridor && !authoredConnection) {
      navigation.blockedEdge = this.invaderEdgeKey(enemy.roomId, nextRoomId);
      navigation.blockedUntil = this.elapsed + INVADER_BLOCKED_EDGE_SECONDS;
      this.scheduleInvaderReplan(enemy.id, false);
      return;
    }
    const authoredPoints = authoredConnection
      ? (authoredConnection.from === enemy.roomId ? authoredConnection.points : [...authoredConnection.points].reverse())
      : null;
    if (authoredPoints && navigation.corridorConnectionId !== authoredConnection?.id) {
      navigation.corridorWaypointIndex = this.furthestReachableConnectionPoint(enemy.x, enemy.y, authoredPoints);
      navigation.corridorConnectionId = authoredConnection?.id ?? null;
    }
    if (authoredPoints && navigation.corridorWaypointIndex < authoredPoints.length) {
      const rawTarget = authoredPoints[navigation.corridorWaypointIndex]!;
      const toward = authoredPoints[navigation.corridorWaypointIndex + 1] ?? this.roomWorldCenterOf(nextRoomId);
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
    const nextCenter = this.roomWorldCenterOf(nextRoomId);
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
    const center = this.roomWorldCenterOf(roomId);
    const rect = this.roomRectOf(roomId);
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
    const zone = this.rooms.get(enemy.roomId)?.zone;
    const world = zone ? this.zoneWorlds.get(zone) : null;
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
    const resolved = this.authoredSpatialIndex
      ? resolveWalkableDiscPointIndexed(this.authoredSpatialIndex, desiredX, desiredY, enemy.x, enemy.y, ACTOR_COLLISION_RADIUS)
      : resolveWalkablePoint(world.rects, desiredX, desiredY, enemy.x, enemy.y);
    enemy.x = resolved.x;
    enemy.y = resolved.y;

    const containing = this.authoredWorld
      ? this.authoredRoomAt(enemy.x, enemy.y)
      : roomContainingPoint(world.grid, enemy.x, enemy.y) as CoreRoomId | null;
    if (expectedRoomId && containing === expectedRoomId) {
      enemy.roomId = expectedRoomId;
      enemy.pathIndex += 1;
      navigation.portalPassed = false;
      navigation.corridorWaypointIndex = 0;
      navigation.corridorConnectionId = null;
      this.markEnemyTransform(enemy, previousX, previousY, previousRoomId, delta);
      this.resetInvaderStall(enemy, navigation);
      return;
    }
    if (containing && containing !== enemy.roomId && containing !== expectedRoomId) {
      enemy.roomId = containing;
      this.markEnemyTransform(enemy, previousX, previousY, previousRoomId, delta);
      this.scheduleInvaderReplan(enemy.id, false);
      return;
    }
    this.markEnemyTransform(enemy, previousX, previousY, previousRoomId, delta);
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
        navigation.blockedEdge = this.invaderEdgeKey(enemy.roomId, nextRoomId);
        navigation.blockedUntil = this.elapsed + INVADER_BLOCKED_EDGE_SECONDS;
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

  private transferInvaderToPreviousZone(enemy: CoreEnemy, navigation: InvaderNavigation): void {
    const zone = this.rooms.get(enemy.roomId)?.zone;
    if (!zone || zone === 1) return;
    const previousZone = (zone - 1) as ZoneId;
    const gateRoomId = this.maps.zones[previousZone - 1].gateRoomId;
    const gate = [...this.enemies.values()].find((candidate) => (
      candidate.kind === "gate" && candidate.roomId === gateRoomId
    ));
    const destination = gate ? { x: gate.spawnX, y: gate.spawnY } : this.roomWorldCenterOf(gateRoomId);
    enemy.roomId = gateRoomId;
    enemy.x = destination.x;
    enemy.y = destination.y;
    enemy.transformRevision += 1;
    enemy.lastMoveSpeed = 0;
    navigation.blockedEdge = null;
    navigation.blockedUntil = 0;
    navigation.targetRoomId = this.maps.zones[previousZone - 1].startRoomId;
    this.replanInvader(enemy, navigation, true);
  }

  private nearestPlayerInRoom(roomId: CoreRoomId, x: number, y: number, range: number): CorePlayer | null {
    let best: CorePlayer | null = null;
    let bestDistance = range;
    for (const player of this.players.values()) {
      if (!player.alive || player.roomId !== roomId) continue;
      const distance = Math.hypot(player.x - x, player.y - y);
      if (distance <= bestDistance) {
        best = player;
        bestDistance = distance;
      }
    }
    return best;
  }

  private roomWorldCenterOf(roomId: CoreRoomId): Readonly<{ x: number; y: number }> {
    return this.roomCenters.get(roomId) ?? { x: 0, y: 0 };
  }

  private roomRectOf(roomId: CoreRoomId): WorldRect {
    const cached = this.roomRects.get(roomId);
    if (cached) return cached;
    const room = this.rooms.get(roomId);
    if (roomId === BOSS_ROOM_ID) return bossWorldRect();
    return room ? roomWorldRect({ x: room.gridX, y: room.gridY }) : { x: 0, y: 0, width: ROOM_WIDTH, height: ROOM_HEIGHT };
  }

  private addRoomToSpatialCells(roomId: CoreRoomId, rect: WorldRect): void {
    const cellSize = 256;
    const minColumn = Math.floor(rect.x / cellSize);
    const maxColumn = Math.floor((rect.x + Math.max(0, rect.width - Number.EPSILON)) / cellSize);
    const minRow = Math.floor(rect.y / cellSize);
    const maxRow = Math.floor((rect.y + Math.max(0, rect.height - Number.EPSILON)) / cellSize);
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let column = minColumn; column <= maxColumn; column += 1) {
        const columns = this.authoredRoomCells.get(row) ?? new Map<number, CoreRoomId[]>();
        const bucket = columns.get(column) ?? [];
        bucket.push(roomId);
        columns.set(column, bucket);
        this.authoredRoomCells.set(row, columns);
      }
    }
  }

  private authoredRoomAt(x: number, y: number): CoreRoomId | null {
    const row = Math.floor(y / 256);
    const column = Math.floor(x / 256);
    for (const roomId of this.authoredRoomCells.get(row)?.get(column) ?? []) {
      const rect = this.roomRects.get(roomId);
      if (rect && pointInWorldRect(x, y, rect)) return roomId;
    }
    return null;
  }

  private startRoomId(): CoreRoomId {
    return this.authoredWorld?.baseRoomId ?? this.maps.zones[0].startRoomId;
  }

  private bossRoomId(): CoreRoomId {
    return this.authoredWorld?.bossRoomId ?? BOSS_ROOM_ID;
  }

  private authoredWalkable(): readonly WorldRect[] {
    if (!this.authoredWorld) return [];
    const bossAccessible = this.day >= 3 && !this.hasLivingAuthoredGate();
    if (this.authoredWalkableCache?.bossAccessible === bossAccessible) return this.authoredWalkableCache.rects;
    if (bossAccessible) {
      this.authoredWalkableCache = { bossAccessible, rects: this.authoredWorld.walkable };
      return this.authoredWorld.walkable;
    }
    const bossId = this.authoredWorld.bossRoomId;
    let rects = authoredWalkableWithoutBossCache.get(this.authoredWorld);
    if (!rects) {
      rects = [
        ...this.authoredWorld.rooms.filter((room) => room.id !== bossId).map((room) => room.rect),
        ...this.authoredWorld.connections.filter((connection) => connection.from !== bossId && connection.to !== bossId).flatMap((connection) => connection.floorRects),
      ];
      authoredWalkableWithoutBossCache.set(this.authoredWorld, rects);
    }
    this.authoredWalkableCache = { bossAccessible, rects };
    return rects;
  }

  private movePlayer(player: CorePlayer, deltaX: number, deltaY: number): boolean {
    if (!this.authoredWorld) return movePlayerWorld(player, deltaX, deltaY, this.rooms);
    const resolved = resolveWalkableDiscPoint(
      this.authoredWalkable(),
      player.x + deltaX,
      player.y + deltaY,
      player.x,
      player.y,
      ACTOR_COLLISION_RADIUS,
    );
    const containing = this.authoredWorld.rooms.find((room) => pointInWorldRect(resolved.x, resolved.y, room.rect));
    if (containing && containing.id !== player.roomId && !this.canEnterRoom(player, containing.id)) return false;
    player.x = resolved.x;
    player.y = resolved.y;
    if (!containing || containing.id === player.roomId) return false;
    player.roomId = containing.id;
    if (containing.id === this.authoredWorld.bossRoomId && this.phase !== "boss") this.enterBossEncounter();
    return true;
  }

  private canEnterRoom(player: CorePlayer, destinationId: CoreRoomId): boolean {
    const destination = this.rooms.get(destinationId);
    const source = this.rooms.get(player.roomId);
    if (!destination || !source || destination.zone <= this.currentZone) return true;
    if (!this.hasLivingGateInZone(this.currentZone)) return true;
    this.pushZoneGateWarning(player.userId, this.currentZone);
    return false;
  }

  private hasLivingGateInZone(zone: ZoneId): boolean {
    return [...this.enemies.values()].some((enemy) => (
      enemy.kind === "gate" && enemy.alive && this.rooms.get(enemy.roomId)?.zone === zone
    ));
  }

  private pushZoneGateWarning(userId: string, zone: ZoneId): void {
    if (userId.startsWith("ai:")) return;
    const key = `${userId}:ZONE_GATE_LOCKED`;
    if ((this.noticeCooldowns.get(key) ?? -Infinity) > this.elapsed) return;
    this.noticeCooldowns.set(key, this.elapsed + 1.5);
    this.notices.push({
      userId,
      code: "ZONE_GATE_LOCKED",
      message: `구역 ${zone}의 게이트를 모두 파괴해야 다음 구역에 진입할 수 있습니다.`,
    });
  }

  private authoredSpawnGate(zone: ZoneId): CoreEnemy | null {
    if (!this.authoredWorld) return null;
    // Only the current progression zone may create a wave. Gates do not need
    // to be discovered, but earlier-zone gates never resume after advancing.
    const gates = [...this.enemies.values()]
      .filter((enemy) => enemy.kind === "gate" && enemy.alive && this.rooms.get(enemy.roomId)?.zone === zone)
      .sort((left, right) => left.roomId.localeCompare(right.roomId));
    if (gates.length === 0) return null;
    return gates[this.invaderSerial % gates.length] ?? gates[0] ?? null;
  }

  private hasLivingAuthoredGate(): boolean {
    return Boolean(this.authoredWorld && [...this.enemies.values()].some((enemy) => enemy.kind === "gate" && enemy.alive));
  }

  private shortestRoomPath(from: CoreRoomId, destination: CoreRoomId): CoreRoomId[] | null {
    const key = `room:${from}>${destination}`;
    const cached = this.routeCache.get(key);
    if (cached) return [...cached];
    const path = this.weightedRoomPath(from, destination, () => true);
    if (path) this.routeCache.set(key, path);
    return path;
  }

  private doorTopologyKey(): string {
    let key = "";
    for (const door of this.doors.values()) key += door.open && !door.locked ? "1" : "0";
    return key;
  }

  private weightedRoomPath(
    from: CoreRoomId,
    destination: CoreRoomId,
    traversable: (from: CoreRoomId, to: CoreRoomId) => boolean,
  ): CoreRoomId[] | null {
    const previous = new Map<CoreRoomId, CoreRoomId | null>([[from, null]]);
    const distances = new Map<CoreRoomId, number>([[from, 0]]);
    const queue: Array<{ roomId: CoreRoomId; distance: number }> = [{ roomId: from, distance: 0 }];
    while (queue.length > 0) {
      queue.sort((left, right) => left.distance - right.distance || left.roomId.localeCompare(right.roomId));
      const current = queue.shift()!;
      if (current.distance > (distances.get(current.roomId) ?? Number.POSITIVE_INFINITY) + SIMULATION_EPSILON) continue;
      if (current.roomId === destination) break;
      for (const next of [...(this.rooms.get(current.roomId)?.connections ?? [])].sort()) {
        if (!traversable(current.roomId, next)) continue;
        const candidate = current.distance + this.roomConnectionTravelCost(current.roomId, next);
        if (candidate + SIMULATION_EPSILON >= (distances.get(next) ?? Number.POSITIVE_INFINITY)) continue;
        distances.set(next, candidate);
        previous.set(next, current.roomId);
        queue.push({ roomId: next, distance: candidate });
      }
    }
    if (!distances.has(destination)) return null;
    const path: CoreRoomId[] = [];
    let cursor: CoreRoomId | null = destination;
    while (cursor) { path.push(cursor); cursor = previous.get(cursor) ?? null; }
    return path.reverse();
  }

  private roomConnectionTravelCost(from: CoreRoomId, to: CoreRoomId): number {
    const fromCenter = this.roomWorldCenterOf(from);
    const toCenter = this.roomWorldCenterOf(to);
    const connection = this.authoredConnectionsByEdge.get(this.invaderEdgeKey(from, to));
    if (!connection) return Math.hypot(toCenter.x - fromCenter.x, toCenter.y - fromCenter.y);
    const points = connection.from === from ? connection.points : [...connection.points].reverse();
    const route = [fromCenter, ...points, toCenter];
    let distance = 0;
    for (let index = 1; index < route.length; index += 1) {
      const previousPoint = route[index - 1]!;
      const point = route[index]!;
      distance += Math.hypot(point.x - previousPoint.x, point.y - previousPoint.y);
    }
    return distance;
  }

  private damageBase(rawDamage: number): void {
    this.baseHp = Math.max(0, this.baseHp - Math.max(1, Math.round(rawDamage)));
    if (this.baseHp === 0) this.finish("defeat", "베이스 캠프가 파괴되었습니다.");
  }

  /**
   * Server-side AI for `ai:` party members. The first AI guards the base
   * (defender); the rest follow the nearest human leader (follower) and engage
   * enemies in their room. Drives input + aim so the shared movement/attack
   * pipeline moves them normally.
   */
  private updateAiPlayers(): void {
    for (const player of this.players.values()) {
      if (!player.aiRole || !player.alive) {
        if (player.aiRole) { player.inputX = 0; player.inputY = 0; this.aiFollowNavigation.delete(player.userId); }
        continue;
      }
      if (this.phase === "lobby" || this.phase === "ended") { player.inputX = 0; player.inputY = 0; continue; }
      const leader = this.aiLeader(player);
      const targetRoom = player.aiRole === "defender"
        ? this.rooms.get(this.startRoomId())
        : leader ? this.rooms.get(leader.roomId) : null;
      if (!targetRoom) { player.inputX = 0; player.inputY = 0; continue; }
      const recoveryAnchor = player.aiRole === "follower" && leader
        ? this.distantAiFollowAnchor(player, leader)
        : null;
      if (recoveryAnchor) {
        this.aiApproach(player, recoveryAnchor.x, recoveryAnchor.y, 12);
      } else if (player.roomId === targetRoom.id) {
        const anchor = player.aiRole === "follower" && leader
          ? { x: leader.x, y: leader.y }
          : this.roomWorldCenterOf(targetRoom.id);
        this.aiApproach(player, anchor.x, anchor.y, player.aiRole === "follower" ? AI_FOLLOWER_GAP : 40);
      } else {
        const nextRoom = this.nextRoomToward(player.roomId, targetRoom.id);
        const anchor = nextRoom
          ? this.authoredPartyNavigationAnchor(player, nextRoom)
          : this.roomWorldCenterOf(targetRoom.id);
        this.aiApproach(player, anchor.x, anchor.y, 12);
      }
      const enemy = this.nearestPlayerInRoomEnemy(player);
      if (enemy && (this.phase === "day" || this.phase === "night" || this.phase === "boss")) {
        player.aim = Math.atan2(enemy.y - player.y, enemy.x - player.x);
        this.performAutoAttack(player.userId);
      }
    }
  }

  private moveEnemyToward(enemy: CoreEnemy, x: number, y: number, delta: number): void {
    const previousX = enemy.x;
    const previousY = enemy.y;
    const dx = x - enemy.x;
    const dy = y - enemy.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= 0) return;
    const step = Math.min(distance, enemy.speed * delta);
    const room = this.rooms.get(enemy.spawnRoomId);
    const bounds = room ? this.roomRectOf(room.id) : null;
    const nextX = enemy.x + dx / distance * step;
    const nextY = enemy.y + dy / distance * step;
    const inset = this.authoredWorld ? ACTOR_COLLISION_RADIUS : 0;
    enemy.x = bounds ? clamp(nextX, bounds.x + inset, bounds.x + bounds.width - inset) : nextX;
    enemy.y = bounds ? clamp(nextY, bounds.y + inset, bounds.y + bounds.height - inset) : nextY;
    this.markEnemyTransform(enemy, previousX, previousY, enemy.roomId, delta);
  }

  private markEnemyTransform(
    enemy: CoreEnemy,
    previousX: number,
    previousY: number,
    previousRoomId: CoreRoomId,
    delta: number,
  ): void {
    const distance = Math.hypot(enemy.x - previousX, enemy.y - previousY);
    if (distance <= 0 && enemy.roomId === previousRoomId) return;
    enemy.transformRevision += 1;
    enemy.lastMoveSpeed = delta > 0 ? distance / delta : 0;
  }

  private nextRoomToward(from: CoreRoomId, destination: CoreRoomId): CoreRoomId | null {
    if (from === destination) return destination;
    const queue: CoreRoomId[] = [from];
    const previous = new Map<CoreRoomId, CoreRoomId | null>([[from, null]]);
    while (queue.length > 0) {
      const current = queue.shift() as CoreRoomId;
      for (const connection of this.rooms.get(current)?.connections ?? []) {
        if (previous.has(connection)) continue;
        previous.set(connection, current);
        if (connection === destination) {
          let cursor: CoreRoomId = destination;
          while (previous.get(cursor) && previous.get(cursor) !== from) cursor = previous.get(cursor) as CoreRoomId;
          return cursor;
        }
        queue.push(connection);
      }
    }
    return null;
  }

  private authoredPartyNavigationAnchor(
    player: CorePlayer,
    nextRoomId: CoreRoomId,
  ): Readonly<{ x: number; y: number }> {
    if (!this.authoredWorld) return this.roomWorldCenterOf(nextRoomId);
    const connection = this.authoredWorld.connections.find((candidate) => (
      candidate.from === player.roomId && candidate.to === nextRoomId
      || candidate.to === player.roomId && candidate.from === nextRoomId
    ));
    if (!connection) return this.roomWorldCenterOf(nextRoomId);
    const points = connection.from === player.roomId ? connection.points : [...connection.points].reverse();
    const existing = this.partyNavigation.get(player.userId);
    const navigation = existing?.from === player.roomId && existing.to === nextRoomId
      ? existing
      : {
          from: player.roomId,
          to: nextRoomId,
          // The room id remains the source room while an actor is physically
          // inside its corridor. Restarting at point zero would send an actor
          // that already passed the doorway back in the opposite direction.
          waypointIndex: this.furthestReachableConnectionPoint(player.x, player.y, points),
        };
    while (navigation.waypointIndex < points.length) {
      const point = points[navigation.waypointIndex]!;
      if (Math.hypot(point.x - player.x, point.y - player.y) > 24) break;
      navigation.waypointIndex += 1;
    }
    this.partyNavigation.set(player.userId, navigation);
    return points[navigation.waypointIndex] ?? this.roomWorldCenterOf(nextRoomId);
  }

  private furthestReachableConnectionPoint(
    x: number,
    y: number,
    points: readonly Readonly<{ x: number; y: number }>[],
  ): number {
    if (!this.authoredWorld) return 0;
    let furthest = 0;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!;
      const reachable = this.authoredSpatialIndex
        ? isWalkableDiscLineIndexed(this.authoredSpatialIndex, x, y, point.x, point.y, ACTOR_COLLISION_RADIUS)
        : isWalkableDiscLine(this.authoredWalkable(), x, y, point.x, point.y, ACTOR_COLLISION_RADIUS);
      if (reachable) {
        furthest = index;
      }
    }
    return furthest;
  }

  private aiLeader(ai: CorePlayer): CorePlayer | null {
    let best: CorePlayer | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of this.players.values()) {
      if (candidate.userId === ai.userId || candidate.aiRole || !candidate.alive) continue;
      const distance = Math.hypot(candidate.x - ai.x, candidate.y - ai.y);
      if (distance < bestDistance) { best = candidate; bestDistance = distance; }
    }
    return best ?? [...this.players.values()].find((candidate) => candidate.userId !== ai.userId && candidate.alive) ?? null;
  }

  private distantAiFollowAnchor(player: CorePlayer, leader: CorePlayer): Readonly<{ x: number; y: number }> | null {
    const distance = Math.hypot(leader.x - player.x, leader.y - player.y);
    const playerRoom = this.rooms.get(player.roomId);
    const leaderRoom = this.rooms.get(leader.roomId);
    const rects = this.authoredWorld
      ? this.authoredWalkable()
      : playerRoom?.zone === leaderRoom?.zone ? this.zoneWorlds.get(playerRoom?.zone ?? 1)?.rects : null;
    if (!rects) return null;

    // Straight-line distance is not a valid navigation criterion: two close
    // positions can still be separated by a wall. Only bypass A* when the
    // actor's full collision disc has a direct walkable line to the leader.
    // Otherwise A* accumulates the real route length around corridor bends.
    if (isWalkableDiscLine(rects, player.x, player.y, leader.x, leader.y, ACTOR_COLLISION_RADIUS)) {
      this.aiFollowNavigation.delete(player.userId);
      return player.roomId === leader.roomId ? null : { x: leader.x, y: leader.y };
    }
    if (player.roomId === leader.roomId && distance <= AI_FOLLOWER_GAP) {
      this.aiFollowNavigation.delete(player.userId);
      return null;
    }

    let navigation = this.aiFollowNavigation.get(player.userId);
    const targetDrift = navigation
      ? Math.hypot(leader.x - navigation.targetX, leader.y - navigation.targetY)
      : Number.POSITIVE_INFINITY;
    if (!navigation || this.elapsed >= navigation.replanAt || targetDrift >= AI_PATH_TARGET_DRIFT) {
      const path = findWalkableDiscPath(
        rects,
        { x: player.x, y: player.y },
        { x: leader.x, y: leader.y },
        ACTOR_COLLISION_RADIUS,
      );
      if (!path || path.length === 0) {
        this.aiFollowNavigation.delete(player.userId);
        return null;
      }
      navigation = {
        targetX: leader.x,
        targetY: leader.y,
        path,
        waypointIndex: 0,
        replanAt: this.elapsed + AI_PATH_REPLAN_SECONDS,
      };
      this.aiFollowNavigation.set(player.userId, navigation);
    }

    while (navigation.waypointIndex < navigation.path.length) {
      const waypoint = navigation.path[navigation.waypointIndex]!;
      if (Math.hypot(waypoint.x - player.x, waypoint.y - player.y) > AI_PATH_WAYPOINT_RADIUS) return waypoint;
      navigation.waypointIndex += 1;
    }
    this.aiFollowNavigation.delete(player.userId);
    return null;
  }

  private aiApproach(player: CorePlayer, x: number, y: number, desiredGap: number): void {
    const dx = x - player.x;
    const dy = y - player.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= desiredGap) { player.inputX = 0; player.inputY = 0; return; }
    player.inputX = dx / distance;
    player.inputY = dy / distance;
  }

  private nearestPlayerInRoomEnemy(player: CorePlayer): CoreEnemy | null {
    const rules = CLASS_COMBAT_RULES[player.heroClass];
    return selectNearestConeEnemy(player, this.enemies.values(), rules.attackRange, Math.PI);
  }

  private updateResourceProduction(delta: number): void {
    for (const [roomId, accumulated] of this.resourceAccumulators) {
      const room = this.rooms.get(roomId);
      if (!room?.discovered || room.kind !== "resource") continue;
      let next = accumulated + delta;
      while (next + SIMULATION_EPSILON >= RESOURCE_PRODUCTION_SECONDS) {
        next -= RESOURCE_PRODUCTION_SECONDS;
        this.gold += 1;
      }
      this.resourceAccumulators.set(roomId, Math.max(0, next));
    }
  }

  private refreshCurrentZone(): void {
    let zone: ZoneId = 1;
    for (const player of this.players.values()) {
      const room = this.rooms.get(player.roomId);
      if (room && room.zone > zone) zone = room.zone;
    }
    if (zone > this.currentZone) this.currentZone = zone;
  }
}

export function createCoreViewSnapshot(core: GameCore): CoreViewSnapshot {
  return {
    phase: core.phase,
    result: core.result,
    resultReason: core.resultReason,
    day: core.day,
    elapsed: core.elapsed,
    phaseRemaining: core.phaseRemaining,
    baseHp: core.baseHp,
    baseMaxHp: core.baseMaxHp,
    gold: core.gold,
    currentZone: core.currentZone,
    teamLevel: core.teamLevel,
    teamXp: core.teamXp,
    teamXpToNext: core.teamXpToNext,
    players: [...core.players.values()],
    rooms: [...core.rooms.values()].filter((room) => room.discovered),
    doors: [...core.doors.values()].filter((door) => core.discoveredRooms.has(door.fromRoomId) || core.discoveredRooms.has(door.toRoomId)),
    enemies: [...core.enemies.values()].filter((enemy) => core.discoveredRooms.has(enemy.roomId)),
    drops: [...core.drops.values()],
    waypoints: [...core.waypoints.values()].filter((waypoint) => core.discoveredRooms.has(waypoint.roomId)),
  };
}

function createAuthoredRuntimeWorld(
  definition: CoreWorldDefinition,
  seed: string,
  difficulty: GameCoreOptions["difficulty"],
): RuntimeWorld {
  const rooms = new Map<CoreRoomId, CoreRoom>();
  const doors = new Map<string, CoreDoor>();
  const enemies = new Map<string, CoreEnemy>();
  const waypoints = new Map<string, CoreWaypoint>();
  for (const room of definition.rooms) {
    rooms.set(room.id, {
      id: room.id,
      zone: room.zone,
      gridX: room.mapX,
      gridY: room.mapY,
      kind: room.kind,
      depth: room.depth,
      connections: room.connections,
      discovered: room.id === definition.baseRoomId,
      cleared: ["start", "resource", "empty", "central-waypoint"].includes(room.kind),
      rect: room.rect,
    });
    const enemyKind = room.kind === "static-monster" ? "static"
      : room.kind === "hidden-monster" ? "hidden"
        : room.kind === "gate" ? "gate" : null;
    if (enemyKind) {
      const enemy = createSeededRoomEnemy(
        seed,
        room.id,
        room.zone,
        enemyKind,
        difficulty,
        room.rect.x,
        room.rect.y,
        room.rect.width,
        room.rect.height,
      );
      enemies.set(enemy.id, enemy);
    }
  }
  for (const connection of definition.connections) {
    const from = rooms.get(connection.from);
    doors.set(doorId(connection.from, connection.to), {
      id: doorId(connection.from, connection.to),
      zone: from?.zone ?? 1,
      fromRoomId: connection.from,
      toRoomId: connection.to,
      open: true,
      locked: false,
    });
  }
  const base = rooms.get(definition.baseRoomId);
  const baseCenter = base
    ? { x: base.rect!.x + base.rect!.width / 2, y: base.rect!.y + base.rect!.height / 2 }
    : { x: 0, y: 0 };
  const baseWaypointId = waypointId(definition.baseRoomId, "start");
  waypoints.set(baseWaypointId, {
    id: baseWaypointId,
    roomId: definition.baseRoomId,
    zone: base?.zone ?? 1,
    kind: "start",
    ...baseCenter,
    destinationId: baseWaypointId,
    active: true,
    requiredPlayers: 0,
    holdingPlayers: 0,
    holdProgress: 0,
    holdDurationMs: WAYPOINT_HOLD_SECONDS * 1_000,
  });

  const zones = ([1, 2, 3] as const).map((zone) => {
    const authoredRooms = definition.rooms.filter((room) => room.zone === zone && room.kind !== "boss");
    const fallback = authoredRooms[0]?.id ?? definition.baseRoomId;
    const startRoomId = zone === 1 ? definition.baseRoomId : fallback;
    const gateRoomId = authoredRooms.find((room) => room.kind === "gate")?.id ?? fallback;
    return {
      seed,
      zone,
      width: 5,
      height: 5,
      startRoomId,
      gateRoomId,
      rooms: authoredRooms.map((room) => ({
        id: room.id,
        zone,
        x: 0,
        y: 0,
        type: room.kind === "boss" ? "empty" : room.kind,
        connections: room.connections,
        depthScore: room.depth,
      })),
    };
  });
  const maps = { seed, zones } as unknown as ThreeZoneMap;
  return { maps, rooms, doors, enemies, waypoints };
}

function pointInWorldRect(x: number, y: number, rect: WorldRect): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function aiAugmentScore(heroClass: HeroClassId, id: string): number {
  const classPriority: Record<HeroClassId, readonly string[]> = {
    swordsman: ["swordsman-execution", "swordsman-combo", "swordsman-whirlwind", "swordsman-blade", "power", "area-power", "haste", "multishot"],
    archer: ["archer-volley", "archer-piercing", "archer-ricochet", "archer-sniper", "multishot", "precision", "haste", "power"],
    mage: ["mage-overcharge", "mage-chain", "mage-nova", "mage-echo", "skill-power", "area-power", "haste", "power"],
  };
  const index = classPriority[heroClass].indexOf(id);
  return index < 0 ? 10 : 100 - index;
}

export function shouldAiYieldEquipment(item: PersonalHiddenDrop, humanEquipment: PersonalHiddenDrop | null): boolean {
  return item.specialOptionCount === 0 && equipmentPower(item) > equipmentPower(humanEquipment);
}

function deterministicCombatRoll(seed: string | number, playerId: string, attackCount: number): number {
  const value = `${seed}:${playerId}:${attackCount}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0) / 0x1_0000_0000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampUpdateRate(value: number): number {
  if (!Number.isFinite(value)) return 60;
  return clamp(Math.round(value), 1, 60);
}
