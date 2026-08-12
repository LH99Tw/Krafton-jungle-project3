import { NIGHT_ATTACK_RANGE_MULTIPLIER, NIGHT_PLAYER_VISION_RADIUS, PLAYER_VISION_RADIUS, PROTOCOL_VERSION, type CombatActionEvent, type HeroClassId, type PlayerInputCommand } from "@five-days/protocol";
import { EQUIPMENT_RARITIES, EQUIPMENT_SLOTS, rollPartyHiddenDrops, type EquipmentRarity, type EquipmentSlot, type PersonalHiddenDrop } from "../v02/equipment";
import type { ThreeZoneMap, ZoneId } from "../v02/map";
import {
  addAugmentStack,
  addExperience,
  createAugmentDraft,
  xpRequiredForNextLevel,
  type AugmentId,
} from "../v02/progression";
import {
  BOSS_ROOM_ID,
  CLASS_COMBAT_RULES,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  augmentAttackBonus,
  createBossEnemy,
  createEmptyEquipment,
  createSeededRoomEnemy,
  createRuntimeWorld,
  enemyFanPatternAngles,
  enemyFloorPatternCircles,
  enemyPatternConfig,
  equipmentBonuses,
  equipmentPower,
  makeDraftId,
  movePlayerWorld,
  type CoreDoor,
  type CoreDrop,
  type CoreEnemy,
  type CoreEquipmentBonuses,
  type CoreRoom,
  type CoreRoomId,
  type CoreWaypoint,
  type CoreWorldDefinition,
  PERSONAL_INVENTORY_SIZE,
  type TravelIntent,
} from "../v02/simulation";
import { autoSkillDefinition, type AutoSkillId } from "../v02/skills";
import {
  bossWorldRect,
  buildWorldFromRooms,
  createWalkableSpatialIndex,
  isWalkableDiscLine,
  isWalkableDiscLineIndexed,
  isWalkableLine,
  findWalkableDiscPath,
  resolveWalkableDiscPoint,
  roomWorldRect,
  type WorldRect,
  type WalkableSpatialIndex,
} from "../v02/world";
import { ACTOR_COLLISION_RADIUS, GOLD_ROOM_REWARDS, PLAYER_RESPAWN_SECONDS, RESOURCE_PRODUCTION_SECONDS, SIMULATION_EPSILON, STATIC_RESPAWN_SECONDS, durations } from "./constants";
import { aiAugmentScore, clamp, deterministicCombatRoll, invaderEdgeKey, pointInWorldRect, shouldAiYieldEquipment } from "./helpers";
import { createAuthoredRuntimeWorld } from "./world-build";
import { AiPlayersDirector } from "./systems/AiPlayersDirector";
import { InvaderDirector } from "./systems/InvaderDirector";
import { TravelDirector } from "./systems/TravelDirector";
import type { CoreAltarStat, CoreCombatStats, CoreNotice, CorePhase, CorePlayer, CoreResult, CoreShopOffer, CoreShopStock, CoreShrineKind, CoreSpecialRoomState, GameCoreOptions, InvaderSimulationTiers, TeamProgress } from "./types";
import { createSeededRandom, hashSeed } from "../v02/random";

const authoredWalkableWithoutBossCache = new WeakMap<CoreWorldDefinition, readonly WorldRect[]>();
const ENEMY_AGGRO_MEMORY_SECONDS = 12;
const ENEMY_AGGRO_DAMAGE_BASE = 120;
const ENEMY_AGGRO_DAMAGE_MULTIPLIER = 2;
const ENEMY_AGGRO_PROXIMITY_SCORE = 24;
const ENEMY_AGGRO_CURRENT_TARGET_BONUS = 8;
const ENEMY_AGGRO_SWITCH_RATIO = 1.25;
const ENEMY_AGGRO_SWITCH_MARGIN = 5;
const HIDDEN_ACQUIRE_DISTANCE = 560;
const HIDDEN_LEASH_DISTANCE = 900;
const HIDDEN_RETURN_COMPLETE_DISTANCE = 10;
const HIDDEN_NAVIGATION_PADDING = 160;
const AUTHORED_MAP_TILE_WIDTH = 320;
const AUTHORED_MAP_TILE_HEIGHT = 220;

type EnemyThreatEntry = { value: number; updatedAt: number };

export class GameCore {
  readonly players = new Map<string, CorePlayer>();
  readonly maps: ThreeZoneMap;
  readonly rooms: Map<CoreRoomId, CoreRoom>;
  readonly doors: Map<string, CoreDoor>;
  readonly enemies: Map<string, CoreEnemy>;
  readonly waypoints: Map<string, CoreWaypoint>;
  readonly drops = new Map<string, CoreDrop>();
  readonly discoveredRooms = new Set<CoreRoomId>();
  readonly activatedEnemyRooms = new Set<CoreRoomId>();
  readonly specialRooms = new Map<CoreRoomId, CoreSpecialRoomState>();
  readonly shopStocks = new Map<string, CoreShopStock>();

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

  /** @internal spatial buckets for authored-room point lookup. */
  readonly zoneWorlds = new Map<ZoneId, ReturnType<typeof buildWorldFromRooms>>();
  /** @internal spatial index for authored-world collision resolution. */
  readonly authoredSpatialIndex: WalkableSpatialIndex | null;
  /** @internal lookup of authored connections by undirected edge key. */
  readonly authoredConnectionsByEdge = new Map<string, CoreWorldDefinition["connections"][number]>();

  private readonly minimumPlayers: number;
  /** @internal optional authored world definition consumed by subsystems. */
  readonly authoredWorld: CoreWorldDefinition | null;
  private readonly invaderDirector: InvaderDirector;
  private readonly travelDirector: TravelDirector;
  private readonly aiPlayersDirector: AiPlayersDirector;
  private hiddenDropSerial = 0;
  private compensatedPlayerAttacks = 0;
  private combatActionSequence = 0;
  private combatActionEventCount = 0;
  private readonly combatActionEvents: CombatActionEvent[] = [];
  private readonly resourceAccumulators = new Map<CoreRoomId, number>();
  private readonly vulnerableEnemies = new Map<string, { playerId: string; expiresAt: number }>();
  private readonly markedEnemies = new Map<string, { playerId: string; expiresAt: number }>();
  private readonly authoredRoomCells = new Map<number, Map<number, CoreRoomId[]>>();
  private readonly roomRects = new Map<CoreRoomId, WorldRect>();
  private readonly roomCenters = new Map<CoreRoomId, Readonly<{ x: number; y: number }>>();
  private readonly routeCache = new Map<string, readonly CoreRoomId[]>();
  private readonly staticEnemyIdsByRoom = new Map<CoreRoomId, string[]>();
  private readonly activeCombatRooms = new Set<CoreRoomId>();
  private readonly enemyThreat = new Map<string, Map<string, EnemyThreatEntry>>();
  private authoredWalkableCache: { bossAccessible: boolean; rects: readonly WorldRect[] } | null = null;
  private readonly notices: CoreNotice[] = [];
  private readonly noticeCooldowns = new Map<string, number>();
  private readonly trapEnemyRooms = new Map<string, CoreRoomId>();
  private readonly returningHiddenEnemies = new Set<string>();
  private readonly hiddenNavigationWalkableByEnemy = new Map<string, readonly WorldRect[]>();

  constructor(readonly options: GameCoreOptions) {
    this.minimumPlayers = options.minimumPlayers ?? 3;
    this.authoredWorld = options.world ?? null;
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
      if (["shop", "shrine", "trap", "checkpoint", "gamble", "altar", "gold"].includes(room.kind)) {
        const state: CoreSpecialRoomState = { roomId: room.id, kind: room.kind as CoreSpecialRoomState["kind"] };
        if (room.kind === "shrine") state.shrineKind = this.rollShrineKind(room.id);
        if (room.kind === "trap") state.trapPhase = "idle";
        this.specialRooms.set(room.id, state);
      }
    }
    for (const enemy of this.enemies.values()) {
      if (enemy.behavior === "invader") continue;
      const bucket = this.staticEnemyIdsByRoom.get(enemy.roomId) ?? [];
      bucket.push(enemy.id);
      this.staticEnemyIdsByRoom.set(enemy.roomId, bucket);
    }
    for (const connection of options.world?.connections ?? []) {
      this.authoredConnectionsByEdge.set(invaderEdgeKey(connection.from, connection.to), connection);
    }
    for (const zone of this.maps.zones) {
      this.zoneWorlds.set(zone.zone, options.world
        ? { rects: [...options.world.walkable], grid: new Map(), bossRect: this.roomRectOf(options.world.bossRoomId) }
        : buildWorldFromRooms(
          [...this.rooms.values()].filter((room) => room.zone === zone.zone && room.id !== BOSS_ROOM_ID),
          false,
        ));
    }
    this.invaderDirector = new InvaderDirector(this, options);
    this.travelDirector = new TravelDirector(this);
    this.aiPlayersDirector = new AiPlayersDirector(this);
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
    return this.travelDirector.active;
  }

  get liveInvaderCount(): number {
    return this.invaderDirector.liveCount;
  }

  get pendingInvaderCount(): number {
    return this.invaderDirector.pendingCount;
  }

  get retiredInvaderCount(): number {
    return this.invaderDirector.retiredCount;
  }

  get invaderCapHitCount(): number {
    return this.invaderDirector.capHitCount;
  }

  get invaderSimulationTiers(): InvaderSimulationTiers {
    return this.invaderDirector.simulationTiers;
  }

  setInvaderSchedulerEnabled(enabled: boolean): void {
    this.invaderDirector.setSchedulerEnabled(enabled);
  }

  /** @internal work accounting merged from the invader director and combat pipeline. */
  get invaderWorkMetrics(): Readonly<{
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
    combatAttackEvents: number;
    compensatedAttacks: number;
  }> {
    const work = this.invaderDirector.workMetrics;
    return {
      ...work,
      combatAttackEvents: this.combatActionEventCount,
      compensatedAttacks: this.compensatedPlayerAttacks,
    };
  }

  takeCombatActionEvents(): CombatActionEvent[] {
    return this.combatActionEvents.splice(0, this.combatActionEvents.length);
  }

  /** @deprecated Protocol v9 consumers should use takeCombatActionEvents. */
  takeCombatAttackEvents(): CombatActionEvent[] {
    return this.takeCombatActionEvents();
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
      respawnRemaining: 0,
      ready: false,
      connected: true,
      lastSeq: -1,
      lastInputAt: -Infinity,
      lastButtons: 0,
      inputX: 0,
      inputY: 0,
      equipment: createEmptyEquipment(),
      inventory: Array.from({ length: PERSONAL_INVENTORY_SIZE }, () => null),
      respawnRoomId: startRoomId,
      gambleAttempts: 0,
      altarAttempts: 0,
      altarMultipliers: { attack: 1, attackSpeed: 1, maxHp: 1, moveSpeed: 1, criticalDamage: 1 },
      shrineBuff: null,
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
      skillOriginX: startCenter.x,
      skillOriginY: startCenter.y,
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
    this.updatePlayerRespawns(delta);
    this.updateSpecialRooms(delta);
    this.aiPlayersDirector.update();

    for (const player of this.players.values()) {
      player.autoAttackCooldown = Math.max(0, player.autoAttackCooldown - delta);
      player.qCooldown = Math.max(0, player.qCooldown - delta);
      player.eCooldown = Math.max(0, player.eCooldown - delta);
      player.dashCooldown = Math.max(0, player.dashCooldown - delta);
      if (!player.alive) continue;
      const speed = this.effectiveMoveSpeed(player);
      const transitioned = this.movePlayer(player, player.inputX * speed * delta, player.inputY * speed * delta);
      if (transitioned) this.discoverRoom(player.roomId);
    }

    if (this.phase === "day" || this.phase === "night" || this.phase === "boss") {
      this.updateAutoSkills();
      for (const player of this.players.values()) {
        if (player.connected && player.alive && player.autoAttackCooldown <= 0) this.performAutoAttack(player.userId);
      }
    }
    const previouslyActiveRooms = new Set(this.activeCombatRooms);
    this.activeCombatRooms.clear();
    for (const player of this.players.values()) {
      if (player.alive) this.activeCombatRooms.add(player.roomId);
    }
    for (const roomId of previouslyActiveRooms) {
      if (this.activeCombatRooms.has(roomId)) continue;
      for (const enemyId of this.staticEnemyIdsByRoom.get(roomId) ?? []) {
        const enemy = this.enemies.get(enemyId);
        if (!enemy?.alive || enemy.behavior === "invader") continue;
        this.enemyThreat.delete(enemy.id);
        this.clearEnemyTarget(enemy);
        if (enemy.kind === "static") {
          enemy.x = enemy.spawnX;
          enemy.y = enemy.spawnY;
          enemy.lastMoveSpeed = 0;
        }
      }
    }
    this.updateStaticEnemies(delta);
    this.updatePatternEnemies(delta);
    this.updateStaticRespawns(delta);
    this.invaderDirector.update(delta);
    this.invaderDirector.retireInactive();
    this.invaderDirector.updateSpawning(delta);
    this.updateResourcePickups();
    this.updateResourceProduction(delta);
    this.travelDirector.update(delta);
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
    if (this.trapDebuff(player) === "basic-disabled") return null;
    const rules = CLASS_COMBAT_RULES[player.heroClass];
    const rangeMultiplier = 1 + (player.upgrades["area-power"] ?? 0) * 0.12
      + (player.heroClass === "swordsman" ? (player.upgrades.multishot ?? 0) * 0.2 : 0);
    const bladeRange = player.heroClass === "swordsman" && player.upgrades["swordsman-blade"] ? 240 : 0;
    const range = this.playerAttackRange(Math.max(rules.attackRange * rangeMultiplier, bladeRange));
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
    const shrine = this.activeShrine(player);
    const haste = (player.upgrades.haste ?? 0) * 0.12 + (["berserker", "wind"].includes(shrine ?? "") ? 0.5 : 0);
    const equipmentHaste = equipmentBonuses(player.equipment).attackSpeedBonus / 100;
    const trapRate = this.trapDebuff(player) === "attack-speed" ? 0.5 : 1;
    player.autoAttackCooldown = Math.max(0.12, rules.attackInterval / ((1 + haste + equipmentHaste) * player.altarMultipliers.attackSpeed * trapRate));
    let additionalTargets = player.heroClass === "swordsman" ? 0 : (player.upgrades.multishot ?? 0);
    if (player.heroClass === "archer") {
      additionalTargets += (player.upgrades["archer-volley"] ?? 0) + (player.upgrades["archer-piercing"] ?? 0) * 2 + (player.upgrades["archer-ricochet"] ?? 0);
    } else if (player.heroClass === "mage") additionalTargets += player.upgrades["mage-chain"] ?? 0;
    const attackTargetCount = Math.min(targets.length, 1 + additionalTargets);
    for (let index = 0; index < attackTargetCount; index += 1) {
      const candidate = targets[index]!;
      const secondaryMultiplier = index === 0 ? 1 : player.heroClass === "mage" ? 0.6 : 0.65;
      this.damageEnemy(userId, candidate.id, this.calculateAttackDamage(player, candidate) * secondaryMultiplier);
    }
    this.combatActionEvents.push({
      v: PROTOCOL_VERSION,
      sequence: ++this.combatActionSequence,
      attackerId: player.userId,
      attackerType: "player",
      actionKind: "basic",
      heroClass: player.heroClass,
      targetId: target.id,
      startX: player.x,
      startY: player.y,
      targetX: target.x,
      targetY: target.y,
      aim: player.aim,
      critical: player.lastAttackCritical,
      patternKind: null,
      firedAt: this.elapsed,
    });
    this.combatActionEventCount += 1;
    return target;
  }

  castSkill(userId: string, skillId: "q" | "e" | "dash", aim: number): boolean {
    const player = this.players.get(userId);
    if (!player || !player.alive || this.phase === "lobby" || this.phase === "ended") return false;
    if (skillId !== "dash" && this.trapDebuff(player) === "skills-disabled") return false;
    player.aim = aim;
    if (skillId === "dash") {
      if (player.dashCooldown > 0) return false;
      player.dashCooldown = 5;
      player.skillSequence += 1;
      player.lastSkillId = "dash";
      player.skillOriginX = player.x;
      player.skillOriginY = player.y;
      // Dash follows the held movement direction (arrow keys / WASD) so local
      // and server behavior stay identical; aim is the fallback while idle.
      let dashX = player.inputX;
      let dashY = player.inputY;
      if (Math.hypot(dashX, dashY) < 0.001) {
        dashX = Math.cos(aim);
        dashY = Math.sin(aim);
      }
      this.movePlayer(player, dashX * 145, dashY * 145);
      // The effect target must be the resolved landing point so the client
      // never renders the dodge trail through a wall or off-screen.
      player.skillTargetX = player.x;
      player.skillTargetY = player.y;
      player.skillRadius = 0;
      return true;
    }
    const definition = autoSkillDefinition(player.heroClass, skillId);
    const cooldownKey = skillId === "q" ? "qCooldown" : "eCooldown";
    if (player[cooldownKey] > 0) return false;
    const anchor = this.autoSkillTarget(player, skillId);
    if (!anchor) return false;
    const shrineReduction = this.activeShrine(player) === "infinity" ? 0.7 : 0;
    const cooldownReduction = Math.min(0.7, shrineReduction + (player.upgrades["skill-haste"] ?? 0) * 0.03
      + (player.heroClass === "mage" && player.upgrades["mage-tempo"] ? 0.125 : 0));
    player[cooldownKey] = definition.cooldownSeconds * (1 - cooldownReduction);
    const skillPower = 1 + (player.upgrades["skill-power"] ?? 0) * 0.11;
    const areaMultiplier = (1 + (player.upgrades["area-power"] ?? 0) * 0.06
      + (player.heroClass === "mage" && player.upgrades["mage-nova"] ? 0.275 : 0));
    const shrineAreaMultiplier = this.activeShrine(player) === "giant" ? 2 : 1;
    const targetX = anchor.x;
    const targetY = anchor.y;
    const range = definition.range * areaMultiplier * shrineAreaMultiplier;
    const radius = definition.radius * areaMultiplier * shrineAreaMultiplier;
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
    player.skillOriginX = player.x;
    player.skillOriginY = player.y;
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
    if (enemy.kind === "static" || enemy.kind === "invader") {
      const angle = Math.atan2(enemy.y - player.y, enemy.x - player.x);
      const knockbackDistance = 32;
      const roomRect = this.roomRectOf(enemy.roomId);
      if (roomRect) {
        const targetX = enemy.x + Math.cos(angle) * knockbackDistance;
        const targetY = enemy.y + Math.sin(angle) * knockbackDistance;
        enemy.x = Math.max(roomRect.x + 20, Math.min(roomRect.x + roomRect.width - 20, targetX));
        enemy.y = Math.max(roomRect.y + 20, Math.min(roomRect.y + roomRect.height - 20, targetY));
      } else {
        enemy.x += Math.cos(angle) * knockbackDistance;
        enemy.y += Math.sin(angle) * knockbackDistance;
      }
    }
    if (enemy.behavior !== "invader") {
      this.addEnemyThreat(enemy.id, userId, ENEMY_AGGRO_DAMAGE_BASE + damage * ENEMY_AGGRO_DAMAGE_MULTIPLIER);
      enemy.aggroed = true;
      enemy.targetId ??= userId;
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

  getShopStock(userId: string, roomId: CoreRoomId): CoreShopStock | null {
    const player = this.players.get(userId);
    const room = this.rooms.get(roomId);
    if (!player || !room || room.kind !== "shop") return null;
    const key = `${roomId}:${userId}`;
    let stock = this.shopStocks.get(key);
    if (!stock) {
      stock = { roomId, playerId: userId, rerolls: 0, offers: this.rollShopOffers(room, player, 0) };
      this.shopStocks.set(key, stock);
    }
    return stock;
  }

  shopBuy(userId: string, offerId: string): boolean {
    const player = this.players.get(userId);
    if (!player || !this.canUseSpecialRoom(player, "shop")) return false;
    const stock = this.getShopStock(userId, player.roomId);
    const offer = stock?.offers.find((candidate) => candidate.id === offerId);
    if (!stock || !offer || offer.sold || this.gold < offer.price) return false;
    if (offer.kind === "equipment" && player.inventory.every(Boolean)) return false;
    this.gold -= offer.price;
    player.goldSpent += offer.price;
    if (offer.kind === "heal") player.hp = Math.min(player.maxHp, player.hp + Math.ceil(player.maxHp * 0.5));
    else if (offer.item) player.inventory[player.inventory.findIndex((item) => !item)] = offer.item;
    stock.offers = stock.offers.map((candidate) => candidate.id === offerId ? { ...candidate, sold: true, locked: false } : candidate);
    return true;
  }

  shopReroll(userId: string): boolean {
    const player = this.players.get(userId);
    if (!player || !this.canUseSpecialRoom(player, "shop")) return false;
    const stock = this.getShopStock(userId, player.roomId);
    if (!stock) return false;
    const zone = this.rooms.get(player.roomId)?.zone ?? 1;
    const cost = 10 * zone + stock.rerolls * 5 * zone;
    if (this.gold < cost) return false;
    this.gold -= cost;
    player.goldSpent += cost;
    const preserved = stock.offers.find((offer) => offer.locked && !offer.sold);
    stock.rerolls += 1;
    stock.offers = this.rollShopOffers(this.rooms.get(player.roomId)!, player, stock.rerolls, preserved ? { ...preserved, locked: false } : undefined);
    return true;
  }

  shopLock(userId: string, offerId: string): boolean {
    const player = this.players.get(userId);
    if (!player || !this.canUseSpecialRoom(player, "shop")) return false;
    const stock = this.getShopStock(userId, player.roomId);
    if (!stock || !stock.offers.some((offer) => offer.id === offerId && !offer.sold)) return false;
    stock.offers = stock.offers.map((offer) => ({ ...offer, locked: offer.id === offerId }));
    return true;
  }

  shopSell(userId: string, inventoryIndex: number): boolean {
    const player = this.players.get(userId);
    if (!player || !this.canUseSpecialRoom(player, "shop") || !Number.isInteger(inventoryIndex)) return false;
    const item = player.inventory[inventoryIndex];
    if (!item) return false;
    this.gold += Math.floor(this.equipmentPrice(item, this.rooms.get(player.roomId)?.zone ?? 1) * 0.4);
    player.inventory[inventoryIndex] = null;
    return true;
  }

  shopUpgrade(userId: string, inventoryIndex: number): boolean {
    const player = this.players.get(userId);
    if (!player || !this.canUseSpecialRoom(player, "shop") || !Number.isInteger(inventoryIndex)) return false;
    const item = player.inventory[inventoryIndex];
    const zone = this.rooms.get(player.roomId)?.zone ?? 1;
    const level = item?.upgradeLevel ?? 0;
    const cost = [35, 70, 105][level];
    if (!item || level >= zone || cost === undefined || this.gold < cost) return false;
    this.gold -= cost;
    player.goldSpent += cost;
    player.inventory[inventoryIndex] = { ...item, upgradeLevel: level + 1 };
    this.recalculateTeamPower(player);
    return true;
  }

  equipInventoryItem(userId: string, inventoryIndex: number): boolean {
    const player = this.players.get(userId);
    if (!player || !Number.isInteger(inventoryIndex)) return false;
    const item = player.inventory[inventoryIndex];
    if (!item) return false;
    const previous = player.equipment[item.slot];
    player.inventory[inventoryIndex] = previous;
    this.equipItem(player, item);
    return true;
  }

  claimShrine(userId: string): boolean {
    const player = this.players.get(userId);
    const state = player ? this.specialRooms.get(player.roomId) : null;
    if (!player || !state || state.kind !== "shrine" || state.shrineClaimedBy) return false;
    if (!this.isNearRoomCenter(player, 115)) return false;
    state.shrineClaimingBy = userId;
    state.shrineClaimProgress = 0;
    return true;
  }

  setCheckpoint(userId: string): boolean {
    void userId;
    return false;
  }

  claimGoldRoom(userId: string): number | null {
    const player = this.players.get(userId);
    const state = player ? this.specialRooms.get(player.roomId) : null;
    if (!player || !state || state.kind !== "gold" || state.goldClaimed || !this.isNearRoomCenter(player, 145)) return null;
    const zone = this.rooms.get(player.roomId)?.zone ?? 1;
    const reward = GOLD_ROOM_REWARDS[zone];
    state.goldClaimed = true;
    this.gold += reward;
    return reward;
  }

  playGamble(userId: string): number | null {
    const player = this.players.get(userId);
    if (!player || !this.canUseSpecialRoom(player, "gamble") || player.gambleAttempts >= 3) return null;
    const zone = this.rooms.get(player.roomId)?.zone ?? 1;
    const stake = 25 * zone;
    if (this.gold < stake) return null;
    this.gold -= stake;
    player.goldSpent += stake;
    const roll = createSeededRandom(`gamble:${this.options.seed}:${player.roomId}:${userId}:${player.gambleAttempts}`).next();
    player.gambleAttempts += 1;
    const multiplier = roll < 0.5 ? 0 : roll < 0.85 ? 2 : roll < 0.98 ? 4 : 10;
    const payout = stake * multiplier;
    this.gold += payout;
    return payout;
  }

  rerollAltar(userId: string): Readonly<{ increased: CoreAltarStat; decreased: CoreAltarStat }> | null {
    const player = this.players.get(userId);
    if (!player || !this.canUseSpecialRoom(player, "altar") || player.altarAttempts >= 3) return null;
    const stats: CoreAltarStat[] = ["attack", "attackSpeed", "maxHp", "moveSpeed", "criticalDamage"];
    const random = createSeededRandom(`altar:${this.options.seed}:${player.roomId}:${userId}:${player.altarAttempts}`);
    const increased = random.pick(stats);
    const decreased = random.pick(stats.filter((stat) => stat !== increased));
    const previousMaxHp = player.maxHp;
    player.altarMultipliers[increased] = clamp(player.altarMultipliers[increased] * 1.25, 0.5, 2);
    player.altarMultipliers[decreased] = clamp(player.altarMultipliers[decreased] * 0.85, 0.5, 2);
    player.altarAttempts += 1;
    this.recalculateMaxHp(player, previousMaxHp);
    this.recalculateTeamPower(player);
    return { increased, decreased };
  }

  requestTravel(userId: string, waypointIdValue: string, destinationId?: string): boolean {
    return this.travelDirector.request(userId, waypointIdValue, destinationId);
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
    return this.travelDirector.recall(userId);
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
    return this.invaderDirector.spawn(zone, gateEnemyId);
  }

  /** @internal wave-queue control bridge used by white-box simulation tests. */
  enqueueInvaderWave(gateEnemyId: string, zone: ZoneId, count: number): void {
    this.invaderDirector.enqueueWave(gateEnemyId, zone, count);
  }

  /** @internal wave-queue control bridge used by white-box simulation tests. */
  releaseOldestInvaderWave(): void {
    this.invaderDirector.releaseOldestWave();
  }

  /** @internal wave-queue control bridge used by white-box simulation tests. */
  pruneInvaderWaveQueue(): void {
    this.invaderDirector.pruneWaveQueue();
  }

  /** @internal dead-invader reclamation bridge used by white-box simulation tests. */
  retireInactiveInvaders(): void {
    this.invaderDirector.retireInactive();
  }

  /** @internal invader tick bridge used by white-box simulation tests. */
  updateInvaders(delta: number): void {
    this.invaderDirector.update(delta);
  }

  /** @internal invader spawn bridge used by white-box simulation tests. */
  updateInvaderSpawning(delta: number): void {
    this.invaderDirector.updateSpawning(delta);
  }

  /** @internal deterministic spawn-slot helper bridge used by white-box tests. */
  invaderSpawnPosition(zone: ZoneId, gateEnemy: CoreEnemy, spawnIndex: number): { x: number; y: number } {
    return this.invaderDirector.spawnPosition(zone, gateEnemy, spawnIndex);
  }

  /** @internal deferred replan bridge used by white-box simulation tests. */
  scheduleInvaderReplan(enemyId: string, allowRandom: boolean): void {
    this.invaderDirector.scheduleReplan(enemyId, allowRandom);
  }

  /** @internal deferred replan bridge used by white-box simulation tests. */
  releasePendingInvaderReplans(
    playerTargets: ReadonlyMap<string, CorePlayer>,
    playerRooms: ReadonlySet<CoreRoomId>,
  ): void {
    this.invaderDirector.releaseReplans(playerTargets, playerRooms);
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
    this.travelDirector.cancel();
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
    const shrine = this.activeShrine(player);
    const haste = ((player.upgrades.haste ?? 0) * 0.12 + equipment.attackSpeedBonus / 100)
      * player.altarMultipliers.attackSpeed + (shrine === "berserker" || shrine === "wind" ? 0.5 : 0);
    const rangeMultiplier = 1 + (player.upgrades["area-power"] ?? 0) * 0.12
      + (player.heroClass === "swordsman" ? (player.upgrades.multishot ?? 0) * 0.2 : 0);
    const bladeRange = player.heroClass === "swordsman" && player.upgrades["swordsman-blade"] ? 240 : 0;
    return {
      attackDamage: (rules.attackDamage + equipment.attackBonus + augmentAttackBonus(player.upgrades))
        * player.altarMultipliers.attack * (["berserker", "doom"].includes(shrine ?? "") ? 2 : shrine === "giant" ? 1.5 : 1),
      defense: equipment.defenseBonus,
      criticalChance: shrine === "assassin" || shrine === "doom" ? 100 : (player.upgrades.precision ?? 0) * 6,
      criticalDamage: (150 + (player.upgrades.ferocity ?? 0) * 20 + (shrine === "assassin" ? 50 : 0)) * player.altarMultipliers.criticalDamage,
      attacksPerSecond: (1 + haste) / rules.attackInterval,
      attackRange: this.playerAttackRange(Math.max(rules.attackRange * rangeMultiplier, bladeRange)),
      moveSpeed: this.effectiveMoveSpeed(player),
    };
  }

  // ---------------------------------------------------------------------------
  // World navigation internals (shared with subsystems)
  // ---------------------------------------------------------------------------

  /** @internal */
  roomWorldCenterOf(roomId: CoreRoomId): Readonly<{ x: number; y: number }> {
    return this.roomCenters.get(roomId) ?? { x: 0, y: 0 };
  }

  /** @internal */
  roomRectOf(roomId: CoreRoomId): WorldRect {
    const cached = this.roomRects.get(roomId);
    if (cached) return cached;
    const room = this.rooms.get(roomId);
    if (roomId === BOSS_ROOM_ID) return bossWorldRect();
    return room ? roomWorldRect({ x: room.gridX, y: room.gridY }) : { x: 0, y: 0, width: ROOM_WIDTH, height: ROOM_HEIGHT };
  }

  /** @internal */
  authoredRoomAt(x: number, y: number): CoreRoomId | null {
    const row = Math.floor(y / 256);
    const column = Math.floor(x / 256);
    for (const roomId of this.authoredRoomCells.get(row)?.get(column) ?? []) {
      const rect = this.roomRects.get(roomId);
      if (rect && pointInWorldRect(x, y, rect)) return roomId;
    }
    return null;
  }

  /** @internal */
  hasLivingGateInZone(zone: ZoneId): boolean {
    return [...this.enemies.values()].some((enemy) => (
      enemy.kind === "gate" && enemy.alive && this.rooms.get(enemy.roomId)?.zone === zone
    ));
  }

  /** @internal */
  livingGateInZone(zone: ZoneId): CoreEnemy | null {
    return [...this.enemies.values()].find((enemy) => (
      enemy.kind === "gate" && enemy.alive && this.rooms.get(enemy.roomId)?.zone === zone
    )) ?? null;
  }

  /** @internal */
  authoredSpawnGate(zone: ZoneId): CoreEnemy | null {
    if (!this.authoredWorld) return null;
    // Only the current progression zone may create a wave. Gates do not need
    // to be discovered, but earlier-zone gates never resume after advancing.
    const gates = [...this.enemies.values()]
      .filter((enemy) => enemy.kind === "gate" && enemy.alive && this.rooms.get(enemy.roomId)?.zone === zone)
      .sort((left, right) => left.roomId.localeCompare(right.roomId));
    if (gates.length === 0) return null;
    return gates[this.invaderDirector.currentSpawnSerial % gates.length] ?? gates[0] ?? null;
  }

  /** @internal */
  hasLivingAuthoredGate(): boolean {
    return Boolean(this.authoredWorld && [...this.enemies.values()].some((enemy) => enemy.kind === "gate" && enemy.alive));
  }

  /** @internal */
  shortestRoomPath(from: CoreRoomId, destination: CoreRoomId): CoreRoomId[] | null {
    const key = `room:${from}>${destination}`;
    const cached = this.routeCache.get(key);
    if (cached) return [...cached];
    const path = this.weightedRoomPath(from, destination, () => true);
    if (path) this.routeCache.set(key, path);
    return path;
  }

  /** @internal */
  doorTopologyKey(): string {
    let key = "";
    for (const door of this.doors.values()) key += door.open && !door.locked ? "1" : "0";
    return key;
  }

  /** @internal */
  weightedRoomPath(
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
    while (cursor) {
      path.push(cursor);
      cursor = previous.get(cursor) ?? null;
    }
    return path.reverse();
  }

  /** @internal */
  roomConnectionTravelCost(from: CoreRoomId, to: CoreRoomId): number {
    const fromCenter = this.roomWorldCenterOf(from);
    const toCenter = this.roomWorldCenterOf(to);
    const connection = this.authoredConnectionsByEdge.get(invaderEdgeKey(from, to));
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

  /** @internal */
  markEnemyTransform(
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

  /** @internal */
  furthestReachableConnectionPoint(
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

  /** @internal */
  discoverRoom(roomId: CoreRoomId): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.discovered = true;
    this.discoveredRooms.add(roomId);
    for (const candidate of this.rooms.values()) {
      if (this.isInsideEnemyActivationNeighborhood(room, candidate)) this.activateRoomEnemies(candidate.id);
    }
    if (roomId === this.bossRoomId()) return;
    for (const waypoint of this.waypoints.values()) {
      if (waypoint.roomId === roomId && (waypoint.kind === "start" || waypoint.kind === "central" || waypoint.kind === "checkpoint")) {
        waypoint.active = true;
      }
    }
  }

  private isInsideEnemyActivationNeighborhood(origin: CoreRoom, candidate: CoreRoom): boolean {
    if (!this.authoredWorld) {
      return origin.zone === candidate.zone
        && Math.abs(origin.gridX - candidate.gridX) <= 1
        && Math.abs(origin.gridY - candidate.gridY) <= 1;
    }
    const originRect = this.roomRectOf(origin.id);
    const candidateRect = this.roomRectOf(candidate.id);
    const horizontalGap = Math.max(
      0,
      candidateRect.x - (originRect.x + originRect.width),
      originRect.x - (candidateRect.x + candidateRect.width),
    );
    const verticalGap = Math.max(
      0,
      candidateRect.y - (originRect.y + originRect.height),
      originRect.y - (candidateRect.y + candidateRect.height),
    );
    return horizontalGap <= AUTHORED_MAP_TILE_WIDTH && verticalGap <= AUTHORED_MAP_TILE_HEIGHT;
  }

  private activateRoomEnemies(roomId: CoreRoomId): void {
    if (this.activatedEnemyRooms.has(roomId)) return;
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.kind === "static-monster" || room.kind === "hidden-monster") {
      this.placeUndiscoveredRoomEnemiesAwayFromPlayers(roomId);
    }
    this.activatedEnemyRooms.add(roomId);
  }

  private placeUndiscoveredRoomEnemiesAwayFromPlayers(roomId: CoreRoomId): void {
    const rect = this.roomRectOf(roomId);
    const inset = Math.min(72, Math.max(ACTOR_COLLISION_RADIUS, Math.min(rect.width, rect.height) / 4));
    const left = rect.x + inset;
    const right = rect.x + rect.width - inset;
    const top = rect.y + inset;
    const bottom = rect.y + rect.height - inset;
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const candidates = [
      { x: left, y: top }, { x: right, y: top },
      { x: right, y: bottom }, { x: left, y: bottom },
      { x: centerX, y: top }, { x: right, y: centerY },
      { x: centerX, y: bottom }, { x: left, y: centerY },
    ];
    const players = [...this.players.values()].filter((player) => player.alive && player.connected);
    const visionRadius = this.phase === "night" ? NIGHT_PLAYER_VISION_RADIUS : PLAYER_VISION_RADIUS;
    const score = (point: Readonly<{ x: number; y: number }>) => players.length === 0
      ? visionRadius * visionRadius
      : Math.min(...players.map((player) => (player.x - point.x) ** 2 + (player.y - point.y) ** 2));
    const positions = [...candidates].sort((leftPoint, rightPoint) => score(rightPoint) - score(leftPoint));
    const enemies = [...this.enemies.values()].filter((enemy) => (
      enemy.alive && enemy.roomId === roomId && (enemy.kind === "static" || enemy.kind === "hidden")
    ));
    for (const [index, enemy] of enemies.entries()) {
      // Hidden encounters are authored as a room centerpiece. Do not let the
      // proximity activation pass relocate them to a corner like normal mobs.
      const position = enemy.kind === "hidden"
        ? { x: centerX, y: centerY }
        : positions[index % positions.length]!;
      if (enemy.x === position.x && enemy.y === position.y) continue;
      enemy.x = position.x;
      enemy.y = position.y;
      enemy.spawnX = position.x;
      enemy.spawnY = position.y;
      enemy.transformRevision += 1;
      enemy.lastMoveSpeed = 0;
    }
  }

  /** @internal */
  startRoomId(): CoreRoomId {
    return this.authoredWorld?.baseRoomId ?? this.maps.zones[0].startRoomId;
  }

  /** @internal */
  bossRoomId(): CoreRoomId {
    return this.authoredWorld?.bossRoomId ?? BOSS_ROOM_ID;
  }

  /** @internal */
  authoredWalkable(): readonly WorldRect[] {
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

  /** @internal */
  damageBase(rawDamage: number): void {
    this.baseHp = Math.max(0, this.baseHp - Math.max(1, Math.round(rawDamage)));
    if (this.baseHp === 0) this.finish("defeat", "베이스 캠프가 파괴되었습니다.");
  }

  /** @internal */
  damagePlayer(player: CorePlayer, rawDamage: number): void {
    if (!player.alive) return;
    const defense = equipmentBonuses(player.equipment).defenseBonus;
    player.hp = Math.max(0, player.hp - Math.max(1, Math.round(rawDamage - defense)));
    if (player.hp > 0) return;
    player.alive = false;
    player.respawnRemaining = PLAYER_RESPAWN_SECONDS;
    player.aim = 0;
    player.inputX = 0;
    player.inputY = 0;
    player.lastButtons = 0;
    player.lastAttackTargetId = null;
    player.consecutiveHits = 0;
    player.deaths += 1;
  }

  private updatePlayerRespawns(delta: number): void {
    for (const player of this.players.values()) {
      if (player.alive || player.respawnRemaining <= 0) continue;
      player.respawnRemaining = Math.max(0, player.respawnRemaining - delta);
      if (player.respawnRemaining > SIMULATION_EPSILON) continue;
      player.respawnRemaining = 0;
      const startRoomId = this.rooms.has(player.respawnRoomId) ? player.respawnRoomId : this.startRoomId();
      const startCenter = this.roomWorldCenterOf(startRoomId);
      player.hp = player.maxHp;
      player.alive = true;
      player.roomId = startRoomId;
      player.x = startCenter.x;
      player.y = startCenter.y;
      this.discoverRoom(startRoomId);
      this.aiPlayersDirector.onRespawn(player);
    }
  }

  /** @internal */
  pushZoneGateWarning(userId: string, zone: ZoneId): void {
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

  /** @internal */
  enterBossEncounter(): void {
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
      const bucket = this.staticEnemyIdsByRoom.get(boss.roomId) ?? [];
      bucket.push(boss.id);
      this.staticEnemyIdsByRoom.set(boss.roomId, bucket);
    }
  }

  /** @internal */
  forgetEnemyMarks(enemyId: string): void {
    this.vulnerableEnemies.delete(enemyId);
    this.markedEnemies.delete(enemyId);
  }

  // ---------------------------------------------------------------------------
  // Combat, economy and enemy upkeep internals
  // ---------------------------------------------------------------------------

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
    const rangeSquared = this.playerAttackRange(definition.range) ** 2;
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

  private playerAttackRange(range: number): number {
    return this.phase === "night" ? range * NIGHT_ATTACK_RANGE_MULTIPLIER : range;
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

  private transition(phase: "day" | "night" | "standby"): void {
    this.phase = phase;
    this.phaseRemaining = durations[this.options.mode][phase];
    this.invaderDirector.resetWaveProgress();
  }

  private calculateAttackDamage(player: CorePlayer, enemy: CoreEnemy): number {
    const rules = CLASS_COMBAT_RULES[player.heroClass];
    const shrine = this.activeShrine(player);
    let damage = (rules.attackDamage + equipmentBonuses(player.equipment).attackBonus + augmentAttackBonus(player.upgrades))
      * player.altarMultipliers.attack * (["berserker", "doom"].includes(shrine ?? "") ? 2 : shrine === "giant" ? 1.5 : 1);
    if (this.trapDebuff(player) === "attack") damage *= 0.5;
    const criticalChance = shrine === "assassin" || shrine === "doom" ? 1 : (player.upgrades.precision ?? 0) * 0.06;
    const critical = deterministicCombatRoll(this.options.seed, player.userId, player.attackCount) < criticalChance;
    player.lastAttackCritical = critical;
    if (critical) {
      damage *= (1.5 + (player.upgrades.ferocity ?? 0) * 0.2 + (shrine === "assassin" ? 0.5 : 0)) * player.altarMultipliers.criticalDamage;
    }
    const momentumStacks = player.upgrades.momentum ?? 0;
    if (momentumStacks > 0) damage *= 1 + Math.min(0.2 * momentumStacks, player.consecutiveHits * 0.04 * momentumStacks);
    if (["hidden", "gate", "boss"].includes(enemy.kind)) damage *= 1 + (player.upgrades["boss-hunter"] ?? 0) * 0.12;
    if (player.heroClass === "swordsman" && player.upgrades["swordsman-execution"] && enemy.hp / enemy.maxHp <= 0.3) {
      damage *= 1.6;
    }
    if (player.heroClass === "archer" && player.upgrades["archer-sniper"]) {
      const distance = Math.hypot(enemy.x - player.x, enemy.y - player.y);
      damage *= 1 + Math.min(0.55, Math.max(0, (distance - 180) / 280) * 0.55);
    }
    if (player.heroClass === "swordsman" && player.upgrades["swordsman-combo"] && player.attackCount % 3 === 0) damage *= 2;
    if (player.heroClass === "mage" && player.upgrades["mage-overcharge"] && player.attackCount % 4 === 0) damage *= 2.2;
    if (this.vulnerableEnemies.get(enemy.id)?.playerId === player.userId && (this.vulnerableEnemies.get(enemy.id)?.expiresAt ?? 0) > this.elapsed) damage *= 1.15;
    if (this.markedEnemies.get(enemy.id)?.playerId === player.userId && (this.markedEnemies.get(enemy.id)?.expiresAt ?? 0) > this.elapsed) damage *= 1.25;
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
    this.enemyThreat.delete(enemy.id);
    enemy.patternPhase = "idle";
    enemy.patternRemaining = 0;
    enemy.respawnRemaining = enemy.kind === "static" && !this.trapEnemyRooms.has(enemy.id) ? STATIC_RESPAWN_SECONDS[this.options.mode] : null;
    killer.kills += 1;
    this.gold += enemy.goldReward;
    if (enemy.xpReward > 0) this.addTeamExperience(enemy.xpReward);

    if (enemy.kind === "gate") {
      killer.gatesDestroyed += 1;
      this.travelDirector.unlockGate(enemy.spawnRoomId);
      const gateRoom = this.rooms.get(enemy.spawnRoomId);
      const zone = gateRoom?.zone ?? this.currentZone;
      const zoneGates = [...this.enemies.values()].filter((candidate) => (
        candidate.kind === "gate" && this.rooms.get(candidate.spawnRoomId)?.zone === zone
      ));
      const destroyed = zoneGates.filter((candidate) => !candidate.alive).length;
      const goal = zoneGates.length;
      const allDestroyed = goal > 0 && destroyed >= goal;
      this.notices.push({
        userId: null,
        code: "GATE_DESTROYED",
        message: allDestroyed
          ? `구역 ${zone}의 모든 게이트가 파괴되었습니다. 다음 구역이 개방됩니다!`
          : `구역 ${zone} 게이트 파괴! (${destroyed}/${goal})`,
      });
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
    const previous = player.equipment[item.slot as EquipmentSlot];
    if (previous) {
      const empty = player.inventory.findIndex((entry) => !entry);
      if (empty < 0) return;
      player.inventory[empty] = previous;
    }
    player.equipment[item.slot as EquipmentSlot] = item;
    this.recalculateMaxHp(player, previousMaxHp);
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

  private canUseSpecialRoom(player: CorePlayer, kind: CoreSpecialRoomState["kind"]): boolean {
    // Shop offers and inventories are already scoped to the requesting player.
    // The HUD is visible throughout the shop room, so requiring an unrendered
    // 92px personal hotspot made every visible purchase button look broken.
    return player.alive && this.rooms.get(player.roomId)?.kind === kind && this.specialRooms.get(player.roomId)?.kind === kind;
  }

  private isNearRoomCenter(player: CorePlayer, radius: number): boolean {
    const center = this.roomWorldCenterOf(player.roomId);
    return Math.hypot(player.x - center.x, player.y - center.y) <= radius;
  }

  private equipmentPrice(item: PersonalHiddenDrop, zone: ZoneId): number {
    const base: Record<EquipmentRarity, number> = { normal: 30, rare: 50, epic: 80, legendary: 120, mythic: 180 };
    return base[item.rarity] + zone * 10;
  }

  private rollShopOffers(room: CoreRoom, player: CorePlayer, reroll: number, preserved?: CoreShopOffer): CoreShopOffer[] {
    const random = createSeededRandom(`shop:${this.options.seed}:${room.id}:${player.userId}:${reroll}`);
    const slots = Object.keys(EQUIPMENT_SLOTS) as EquipmentSlot[];
    const offers: CoreShopOffer[] = preserved ? [preserved] : [];
    while (offers.filter((offer) => offer.kind === "equipment").length < 4) {
      const index = offers.length;
      const rarity = this.rollShopRarity(room.zone, random.next());
      const rule = EQUIPMENT_RARITIES[rarity];
      const slot = random.pick(slots);
      const fingerprint = hashSeed(`shop-item:${this.options.seed}:${room.id}:${player.userId}:${reroll}:${index}`).toString(16);
      const item: PersonalHiddenDrop = {
        id: `shop-${room.zone}-${fingerprint}`,
        ownerPlayerId: player.userId,
        zone: room.zone,
        hiddenRoomId: room.id,
        dropIndex: reroll * 10 + index,
        rarity,
        slot,
        statMultiplier: rule.statMultiplier,
        specialOptionCount: rule.specialOptionCount,
        upgradeLevel: 0,
      };
      offers.push({ id: `offer:${item.id}`, kind: "equipment", price: this.equipmentPrice(item, room.zone), sold: false, locked: false, item });
    }
    if (!offers.some((offer) => offer.kind === "heal")) {
      offers.push({ id: `offer:heal:${room.id}:${player.userId}:${reroll}`, kind: "heal", price: [30, 45, 60][room.zone - 1]!, sold: false, locked: false, item: null });
    }
    return offers.slice(0, 5);
  }

  private rollShopRarity(zone: ZoneId, roll: number): EquipmentRarity {
    const table: Record<ZoneId, Array<readonly [EquipmentRarity, number]>> = {
      1: [["normal", 0.65], ["rare", 0.3], ["epic", 0.05]],
      2: [["normal", 0.25], ["rare", 0.45], ["epic", 0.25], ["legendary", 0.05]],
      3: [["rare", 0.25], ["epic", 0.4], ["legendary", 0.28], ["mythic", 0.07]],
    };
    let cumulative = 0;
    for (const [rarity, chance] of table[zone]) {
      cumulative += chance;
      if (roll < cumulative) return rarity;
    }
    return table[zone].at(-1)![0];
  }

  private rollShrineKind(roomId: CoreRoomId): CoreShrineKind {
    const random = createSeededRandom(`shrine:${this.options.seed}:${roomId}`);
    if (random.next() < 0.05) return "doom";
    return random.pick(["berserker", "assassin", "giant", "wind", "infinity"] as const);
  }

  private activeShrine(player: CorePlayer): CoreShrineKind | null {
    return player.shrineBuff && player.shrineBuff.expiresAt > this.elapsed ? player.shrineBuff.kind : null;
  }

  private effectiveMoveSpeed(player: CorePlayer): number {
    const shrine = this.activeShrine(player);
    const shrineMultiplier = shrine === "wind" || shrine === "doom" ? 2 : shrine === "giant" ? 0.8 : 1;
    const trapMultiplier = this.trapDebuff(player) === "move-speed" ? 0.5 : 1;
    return CLASS_COMBAT_RULES[player.heroClass].speed * player.altarMultipliers.moveSpeed * shrineMultiplier * trapMultiplier;
  }

  private trapDebuff(player: CorePlayer): string | null {
    const state = this.specialRooms.get(player.roomId);
    return state?.kind === "trap" && state.trapParticipants?.includes(player.userId) ? state.trapDebuff ?? null : null;
  }

  private recalculateMaxHp(player: CorePlayer, previousMaxHp = player.maxHp): void {
    const ratio = previousMaxHp > 0 ? player.hp / previousMaxHp : 1;
    const base = CLASS_COMBAT_RULES[player.heroClass].hp + equipmentBonuses(player.equipment).maxHpBonus;
    const trapMultiplier = this.trapDebuff(player) === "max-hp" ? 0.5 : 1;
    player.maxHp = Math.max(1, Math.round(base * player.altarMultipliers.maxHp * trapMultiplier));
    player.hp = Math.max(1, Math.min(player.maxHp, Math.round(player.maxHp * ratio)));
  }

  private updateSpecialRooms(delta: number): void {
    for (const player of this.players.values()) {
      if (player.alive && this.rooms.get(player.roomId)?.kind === "shop") this.getShopStock(player.userId, player.roomId);
      if (player.shrineBuff && player.shrineBuff.expiresAt <= this.elapsed) {
        if (player.shrineBuff.kind === "doom" && player.alive) player.hp = 1;
        player.shrineBuff = null;
      }
    }
    for (const state of this.specialRooms.values()) {
      if (state.kind === "shrine" && state.shrineClaimingBy && !state.shrineClaimedBy) {
        const player = this.players.get(state.shrineClaimingBy);
        if (!player?.alive || player.roomId !== state.roomId || !this.isNearRoomCenter(player, 115)) {
          state.shrineClaimingBy = undefined;
          state.shrineClaimProgress = 0;
        } else {
          state.shrineClaimProgress = (state.shrineClaimProgress ?? 0) + delta;
          if (state.shrineClaimProgress >= 3) {
            const durations: Record<CoreShrineKind, number> = { berserker: 60, assassin: 45, giant: 60, wind: 60, infinity: 45, doom: 30 };
            player.shrineBuff = { kind: state.shrineKind!, expiresAt: this.elapsed + durations[state.shrineKind!] };
            state.shrineClaimedBy = player.userId;
            state.shrineClaimingBy = undefined;
            state.shrineClaimProgress = 3;
          }
        }
      }
      if (state.kind === "trap") this.updateTrapRoom(state, delta);
    }
  }

  private updateTrapRoom(state: CoreSpecialRoomState, delta: number): void {
    const participantsInRoom = [...this.players.values()].filter((player) => player.alive && player.roomId === state.roomId);
    if (state.trapPhase === "idle" && participantsInRoom.length > 0) {
      state.trapParticipants = participantsInRoom.map((player) => player.userId).sort();
      state.trapDebuff = this.rollTrapDebuff(state.roomId, state.trapParticipants.length);
      state.trapPhase = "warning";
      state.trapProgress = 0;
      this.moveTrapParticipantsClearOfDoorway(state);
      const room = this.rooms.get(state.roomId);
      if (room) room.cleared = false;
    }
    if (state.trapPhase === "warning") {
      state.trapProgress = (state.trapProgress ?? 0) + delta;
      if (state.trapProgress >= 1) {
        this.spawnTrapWave(state.roomId);
        state.trapPhase = "wave";
      }
    }
    if (state.trapPhase === "wave") {
      const livingWave = [...this.trapEnemyRooms].some(([enemyId, roomId]) => roomId === state.roomId && this.enemies.get(enemyId)?.alive);
      if (!livingWave) {
        this.spawnTrapHidden(state.roomId);
        state.trapPhase = "hidden";
      }
    }
    if (state.trapPhase === "hidden") {
      const living = [...this.trapEnemyRooms].some(([enemyId, roomId]) => roomId === state.roomId && this.enemies.get(enemyId)?.alive);
      if (!living) {
        state.trapPhase = "cleared";
        state.trapDebuff = undefined;
        const room = this.rooms.get(state.roomId);
        if (room) room.cleared = true;
      }
    }
    if (["warning", "wave", "hidden"].includes(state.trapPhase ?? "")) {
      const livingParticipants = (state.trapParticipants ?? []).some((id) => this.players.get(id)?.alive);
      if (!livingParticipants) this.resetTrap(state);
      if (state.trapDebuff === "tether") this.applyTetherDamage(state, delta);
    }
  }

  private rollTrapDebuff(roomId: CoreRoomId, participants: number): string {
    const choices = ["move-speed", "attack", "attack-speed", "skills-disabled", "basic-disabled", "max-hp", "healing-disabled", "vision"];
    if (participants > 1) choices.push("tether");
    return createSeededRandom(`trap:${this.options.seed}:${roomId}:${this.elapsed}`).pick(choices);
  }

  private spawnTrapWave(roomId: CoreRoomId): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const rect = this.roomRectOf(roomId);
    for (let index = 0; index < 10; index += 1) {
      const enemy = createSeededRoomEnemy(`${this.options.seed}:trap:${index}`, roomId, room.zone, "static", this.options.difficulty, rect.x, rect.y, rect.width, rect.height);
      enemy.id = `enemy:trap:${roomId}:${index}`;
      enemy.x = enemy.spawnX = rect.x + rect.width * (0.16 + (index % 5) * 0.17);
      enemy.y = enemy.spawnY = rect.y + rect.height * (index < 5 ? 0.3 : 0.7);
      enemy.respawnRemaining = null;
      this.enemies.set(enemy.id, enemy);
      this.trapEnemyRooms.set(enemy.id, roomId);
      const bucket = this.staticEnemyIdsByRoom.get(roomId) ?? [];
      bucket.push(enemy.id);
      this.staticEnemyIdsByRoom.set(roomId, bucket);
    }
  }

  private moveTrapParticipantsClearOfDoorway(state: CoreSpecialRoomState): void {
    if (!this.authoredWorld) return;
    const room = this.rooms.get(state.roomId);
    const roomRect = this.authoredWorld.rooms.find((entry) => entry.id === state.roomId)?.rect;
    if (!room || !roomRect) return;
    const barriers = this.authoredWorld.connections
      .filter((connection) => connection.from === state.roomId || connection.to === state.roomId)
      .flatMap((connection) => connection.trapBarrier ? [connection.trapBarrier] : []);
    for (const userId of state.trapParticipants ?? []) {
      const player = this.players.get(userId);
      if (!player) continue;
      for (const barrier of barriers) {
        const expanded = expandedBarrier(barrier);
        if (!pointInWorldRect(player.x, player.y, expanded)) continue;
        if (barrier.height >= barrier.width) {
          const direction = Math.sign(roomRect.x + roomRect.width / 2 - (barrier.x + barrier.width / 2)) || 1;
          player.x = barrier.x + barrier.width / 2 + direction * (barrier.width / 2 + ACTOR_COLLISION_RADIUS + 6);
          player.y = clamp(player.y, roomRect.y + ACTOR_COLLISION_RADIUS, roomRect.y + roomRect.height - ACTOR_COLLISION_RADIUS);
        } else {
          const direction = Math.sign(roomRect.y + roomRect.height / 2 - (barrier.y + barrier.height / 2)) || 1;
          player.y = barrier.y + barrier.height / 2 + direction * (barrier.height / 2 + ACTOR_COLLISION_RADIUS + 6);
          player.x = clamp(player.x, roomRect.x + ACTOR_COLLISION_RADIUS, roomRect.x + roomRect.width - ACTOR_COLLISION_RADIUS);
        }
      }
    }
  }

  private spawnTrapHidden(roomId: CoreRoomId): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const rect = this.roomRectOf(roomId);
    const enemy = createSeededRoomEnemy(`${this.options.seed}:trap:hidden`, roomId, room.zone, "hidden", this.options.difficulty, rect.x, rect.y, rect.width, rect.height);
    enemy.id = `enemy:trap-hidden:${roomId}`;
    this.enemies.set(enemy.id, enemy);
    this.trapEnemyRooms.set(enemy.id, roomId);
    const bucket = this.staticEnemyIdsByRoom.get(roomId) ?? [];
    bucket.push(enemy.id);
    this.staticEnemyIdsByRoom.set(roomId, bucket);
  }

  private resetTrap(state: CoreSpecialRoomState): void {
    for (const [enemyId, roomId] of this.trapEnemyRooms) if (roomId === state.roomId) {
      this.enemies.delete(enemyId);
      this.trapEnemyRooms.delete(enemyId);
      const bucket = this.staticEnemyIdsByRoom.get(roomId);
      if (bucket) this.staticEnemyIdsByRoom.set(roomId, bucket.filter((id) => id !== enemyId));
    }
    state.trapPhase = "idle";
    state.trapDebuff = undefined;
    state.trapParticipants = [];
    state.trapProgress = 0;
  }

  private applyTetherDamage(state: CoreSpecialRoomState, delta: number): void {
    const players = (state.trapParticipants ?? []).map((id) => this.players.get(id)).filter((player): player is CorePlayer => Boolean(player?.alive));
    for (const player of players) if (players.some((other) => other !== player && Math.hypot(other.x - player.x, other.y - player.y) > 500)) {
      this.damagePlayer(player, player.maxHp * 0.05 * delta);
    }
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

  private updateStaticEnemies(delta: number): void {
    for (const enemy of this.activeStaticEnemies()) {
      if (!enemy.alive || enemy.kind !== "static") continue;
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - delta);
      const target = this.selectEnemyAggroTarget(enemy, 560, 720);
      if (!target) {
        this.clearEnemyTarget(enemy);
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
        this.recordEnemyCombatAction(enemy, target, "melee");
        this.damagePlayer(target, enemy.damage);
      }
    }
  }

  private updatePatternEnemies(delta: number): void {
    for (const enemy of this.activeStaticEnemies()) {
      if (!enemy.alive || !["hidden", "gate", "boss"].includes(enemy.kind)) continue;
      const tier = enemy.kind === "boss" ? "boss" : enemy.kind === "hidden" ? "hidden" : "gate";
      const config = enemyPatternConfig(tier);
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - delta);
      const target = enemy.kind === "hidden"
        ? this.selectHiddenTarget(enemy)
        : this.selectEnemyAggroTarget(enemy, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
      if (!target) {
        this.clearEnemyTarget(enemy);
        enemy.patternPhase = "idle";
        enemy.patternRemaining = 0;
        if (enemy.kind === "hidden") {
          this.returningHiddenEnemies.add(enemy.id);
          this.moveHiddenToward(enemy, enemy.spawnX, enemy.spawnY, delta);
          if (Math.hypot(enemy.x - enemy.spawnX, enemy.y - enemy.spawnY) <= HIDDEN_RETURN_COMPLETE_DISTANCE) {
            enemy.roomId = enemy.spawnRoomId;
            this.returningHiddenEnemies.delete(enemy.id);
          }
        }
        continue;
      }
      this.returningHiddenEnemies.delete(enemy.id);
      enemy.aggroed = true;
      enemy.targetId = target.userId;
      const targetDistance = Math.hypot(target.x - enemy.x, target.y - enemy.y);
      if (enemy.kind === "hidden") {
        // Hidden monsters are visually large. Stopping at their ranged attack
        // distance made them appear rooted in place, so they keep closing in
        // while their ranged pattern state continues to advance.
        const pursuitDistance = Math.min(72, enemy.attackRange * 0.5);
        if (targetDistance > pursuitDistance) this.moveHiddenToward(enemy, target.x, target.y, delta);
        if (targetDistance > enemy.attackRange) {
          enemy.patternPhase = "idle";
          enemy.patternRemaining = 0;
          continue;
        }
      }
      if (enemy.patternPhase === "idle") {
        if (enemy.attackCooldown > 0) continue;
        enemy.patternKind = enemy.patternIndex % 2 === 0 ? "fan" : "floor";
        enemy.patternPhase = "telegraph";
        enemy.patternRemaining = config.telegraphSeconds;
        this.recordEnemyCombatAction(enemy, target, "pattern-telegraph");
        continue;
      }
      enemy.patternRemaining = Math.max(0, enemy.patternRemaining - delta);
      if (enemy.patternRemaining > SIMULATION_EPSILON) continue;
      this.resolveEnemyPattern(enemy);
      this.recordEnemyCombatAction(enemy, target, "pattern-resolve");
      enemy.patternPhase = "idle";
      enemy.patternIndex += 1;
      enemy.attackCooldown = config.cooldownSeconds;
    }
  }

  private *activeStaticEnemies(): IterableIterator<CoreEnemy> {
    if ([...this.staticEnemyIdsByRoom.values()].some((ids) => ids.some((id) => !this.enemies.has(id)))) {
      this.staticEnemyIdsByRoom.clear();
      for (const enemy of this.enemies.values()) {
        if (enemy.behavior === "invader") continue;
        const bucket = this.staticEnemyIdsByRoom.get(enemy.roomId) ?? [];
        bucket.push(enemy.id);
        this.staticEnemyIdsByRoom.set(enemy.roomId, bucket);
      }
    }
    const yielded = new Set<string>();
    for (const roomId of this.activeCombatRooms) {
      for (const enemyId of this.staticEnemyIdsByRoom.get(roomId) ?? []) {
        const enemy = this.enemies.get(enemyId);
        if (enemy) {
          yielded.add(enemy.id);
          yield enemy;
        }
      }
    }
    for (const enemy of this.enemies.values()) {
      if (yielded.has(enemy.id) || enemy.kind !== "hidden" || (!enemy.aggroed && !this.returningHiddenEnemies.has(enemy.id))) continue;
      yield enemy;
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

  /** @internal Unified reliable combat stream used by every enemy subsystem. */
  recordEnemyCombatAction(
    enemy: CoreEnemy,
    target: CorePlayer | null,
    actionKind: "melee" | "pattern-telegraph" | "pattern-resolve",
  ): void {
    const targetX = target?.x ?? enemy.x;
    const targetY = target?.y ?? enemy.y;
    this.combatActionEvents.push({
      v: PROTOCOL_VERSION,
      sequence: ++this.combatActionSequence,
      attackerId: enemy.id,
      attackerType: "enemy",
      actionKind,
      heroClass: null,
      targetId: target?.userId ?? null,
      startX: enemy.x,
      startY: enemy.y,
      targetX,
      targetY,
      aim: Math.atan2(targetY - enemy.y, targetX - enemy.x),
      critical: false,
      patternKind: actionKind === "melee" ? null : enemy.patternKind,
      firedAt: this.elapsed,
    });
    this.combatActionEventCount += 1;
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
      this.enemyThreat.delete(enemy.id);
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

  private addEnemyThreat(enemyId: string, playerId: string, amount: number): void {
    const table = this.enemyThreat.get(enemyId) ?? new Map<string, EnemyThreatEntry>();
    const previous = table.get(playerId);
    const retained = previous ? this.decayedEnemyThreat(previous) : 0;
    table.set(playerId, { value: retained + Math.max(0, amount), updatedAt: this.elapsed });
    this.enemyThreat.set(enemyId, table);
  }

  private decayedEnemyThreat(entry: EnemyThreatEntry): number {
    const age = Math.max(0, this.elapsed - entry.updatedAt);
    return entry.value * Math.max(0, 1 - age / ENEMY_AGGRO_MEMORY_SECONDS);
  }

  private selectEnemyAggroTarget(enemy: CoreEnemy, acquireRange: number, releaseRange: number): CorePlayer | null {
    const table = this.enemyThreat.get(enemy.id);
    if (table) {
      for (const [playerId, entry] of table) {
        const player = this.players.get(playerId);
        if (!player?.alive || player.roomId !== enemy.roomId || this.decayedEnemyThreat(entry) <= SIMULATION_EPSILON) {
          table.delete(playerId);
        }
      }
      if (table.size === 0) this.enemyThreat.delete(enemy.id);
    }

    let best: { player: CorePlayer; score: number } | null = null;
    let current: { player: CorePlayer; score: number } | null = null;
    for (const player of this.players.values()) {
      if (!player.alive || player.roomId !== enemy.roomId) continue;
      const isCurrent = player.userId === enemy.targetId;
      const range = isCurrent ? releaseRange : acquireRange;
      const distance = Math.hypot(player.x - enemy.x, player.y - enemy.y);
      if (distance > range) continue;
      const proximity = Number.isFinite(range)
        ? ENEMY_AGGRO_PROXIMITY_SCORE * Math.max(0, 1 - distance / Math.max(1, range))
        : ENEMY_AGGRO_PROXIMITY_SCORE / (1 + distance / 240);
      const threatEntry = table?.get(player.userId);
      const score = proximity
        + (threatEntry ? this.decayedEnemyThreat(threatEntry) : 0)
        + (isCurrent ? ENEMY_AGGRO_CURRENT_TARGET_BONUS : 0);
      const candidate = { player, score };
      if (isCurrent) current = candidate;
      if (!best || score > best.score || (score === best.score && player.userId.localeCompare(best.player.userId) < 0)) {
        best = candidate;
      }
    }
    if (!best) return null;
    if (current && best.player.userId !== current.player.userId) {
      const switchThreshold = current.score * ENEMY_AGGRO_SWITCH_RATIO + ENEMY_AGGRO_SWITCH_MARGIN;
      if (best.score < switchThreshold) return current.player;
    }
    return best.player;
  }

  private clearEnemyTarget(enemy: CoreEnemy): void {
    enemy.aggroed = false;
    enemy.targetId = null;
  }

  private selectHiddenTarget(enemy: CoreEnemy): CorePlayer | null {
    const distanceFromSpawn = Math.hypot(enemy.x - enemy.spawnX, enemy.y - enemy.spawnY);
    if (distanceFromSpawn >= HIDDEN_LEASH_DISTANCE) return null;
    const current = enemy.targetId ? this.players.get(enemy.targetId) : null;
    if (current?.alive && Math.hypot(current.x - enemy.spawnX, current.y - enemy.spawnY) <= HIDDEN_LEASH_DISTANCE) return current;
    if (this.returningHiddenEnemies.has(enemy.id)) return null;
    return ([...this.players.values()]
      .filter((player) => player.alive
        && Math.hypot(player.x - enemy.x, player.y - enemy.y) <= HIDDEN_ACQUIRE_DISTANCE
        && Math.hypot(player.x - enemy.spawnX, player.y - enemy.spawnY) <= HIDDEN_LEASH_DISTANCE)
      .sort((left, right) => Math.hypot(left.x - enemy.x, left.y - enemy.y) - Math.hypot(right.x - enemy.x, right.y - enemy.y)))[0] ?? null;
  }

  /**
   * Hidden enemies never pursue outside their leash. Building A* over the full
   * authored map (roughly 10k x 18k in the official world) stalls the shared
   * room simulation when the first hidden enemy wakes up. Keep one stable,
   * cacheable walkable set around each spawn room instead.
   */
  private hiddenNavigationWalkable(enemy: CoreEnemy): readonly WorldRect[] {
    if (!this.authoredWorld) return [];
    const cached = this.hiddenNavigationWalkableByEnemy.get(enemy.id);
    if (cached) return cached;
    const reach = HIDDEN_LEASH_DISTANCE + ACTOR_COLLISION_RADIUS + HIDDEN_NAVIGATION_PADDING;
    const minX = enemy.spawnX - reach;
    const minY = enemy.spawnY - reach;
    const maxX = enemy.spawnX + reach;
    const maxY = enemy.spawnY + reach;
    const walkable = this.authoredWalkable().filter((rect) => (
      rect.x <= maxX
      && rect.x + rect.width >= minX
      && rect.y <= maxY
      && rect.y + rect.height >= minY
    ));
    this.hiddenNavigationWalkableByEnemy.set(enemy.id, walkable);
    return walkable;
  }

  private moveHiddenToward(enemy: CoreEnemy, x: number, y: number, delta: number): void {
    if (!this.authoredWorld) {
      const dx = x - enemy.x;
      const dy = y - enemy.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= 0) return;
      const step = Math.min(distance, enemy.speed * delta);
      const previousX = enemy.x;
      const previousY = enemy.y;
      const previousRoomId = enemy.roomId;
      movePlayerWorld(enemy, dx / distance * step, dy / distance * step, this.rooms);
      this.markEnemyTransform(enemy, previousX, previousY, previousRoomId, delta);
      return;
    }
    const walkable = this.hiddenNavigationWalkable(enemy);
    const path = findWalkableDiscPath(walkable, enemy, { x, y }, ACTOR_COLLISION_RADIUS, 48, 2_000);
    const destination = path?.[0] ?? { x, y };
    this.moveEnemyToward(enemy, destination.x, destination.y, delta, false);
    const roomId = this.authoredRoomAt(enemy.x, enemy.y);
    if (roomId) enemy.roomId = roomId;
  }

  private moveEnemyToward(enemy: CoreEnemy, x: number, y: number, delta: number, clampToSpawnRoom = true): void {
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
    enemy.x = clampToSpawnRoom && bounds ? clamp(nextX, bounds.x + inset, bounds.x + bounds.width - inset) : nextX;
    enemy.y = clampToSpawnRoom && bounds ? clamp(nextY, bounds.y + inset, bounds.y + bounds.height - inset) : nextY;
    this.markEnemyTransform(enemy, previousX, previousY, enemy.roomId, delta);
  }

  private movePlayer(player: CorePlayer, deltaX: number, deltaY: number): boolean {
    if (!this.authoredWorld) return movePlayerWorld(player, deltaX, deltaY, this.rooms);
    const targetX = player.x + deltaX;
    const targetY = player.y + deltaY;
    const crossedLock = this.lockedProgressionBarrierEntries().find(({ barrier }) => movementCrossesBarrier(
      player.x, player.y, targetX, targetY, expandedBarrier(barrier),
    ));
    if (crossedLock) {
      if (crossedLock.warningZone) this.pushZoneGateWarning(player.userId, crossedLock.warningZone);
      return false;
    }
    const resolved = resolveWalkableDiscPoint(
      this.authoredWalkable(),
      targetX,
      targetY,
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

  private lockedProgressionBarriers(): Array<{ x: number; y: number; width: number; height: number }> {
    return this.lockedProgressionBarrierEntries().map(({ barrier }) => barrier);
  }

  private lockedProgressionBarrierEntries(): Array<{
    barrier: { x: number; y: number; width: number; height: number };
    warningZone?: ZoneId;
  }> {
    if (!this.authoredWorld) return [];
    const rooms = new Map(this.authoredWorld.rooms.map((room) => [room.id, room]));
    return this.authoredWorld.connections.flatMap((connection) => {
      const from = rooms.get(connection.from);
      const to = rooms.get(connection.to);
      if (!from || !to) return [];
      const bossConnection = from.id === this.authoredWorld!.bossRoomId || to.id === this.authoredWorld!.bossRoomId;
      const lowerZone = Math.min(from.zone, to.zone) as ZoneId;
      const trapRoomId = from.kind === "trap" ? from.id : to.kind === "trap" ? to.id : null;
      const trapState = trapRoomId ? this.specialRooms.get(trapRoomId) : null;
      const trapLocked = trapState?.kind === "trap" && ["warning", "wave", "hidden"].includes(trapState.trapPhase ?? "");
      const zoneGateLocked = !bossConnection && from.zone !== to.zone && this.hasLivingGateInZone(lowerZone);
      const locked = trapLocked || (bossConnection ? this.day < 3 || this.hasLivingAuthoredGate() : zoneGateLocked);
      if (!locked) return [];
      const warningZone = zoneGateLocked ? lowerZone : undefined;
      if (trapLocked && connection.trapBarrier) return [{ barrier: { ...connection.trapBarrier } }];
      if (connection.lockBarrier) return [{ barrier: { ...connection.lockBarrier }, warningZone }];
      const segment = [...connection.floorRects].sort((left, right) => Math.max(right.width, right.height) - Math.max(left.width, left.height))[0];
      if (!segment) return [];
      const horizontal = segment.width >= segment.height;
      return [{
        barrier: {
          x: segment.x + segment.width / 2 - (horizontal ? 9 : Math.max(44, segment.width - 18) / 2),
          y: segment.y + segment.height / 2 - (horizontal ? Math.max(44, segment.height - 18) / 2 : 9),
          width: horizontal ? 18 : Math.max(44, segment.width - 18),
          height: horizontal ? Math.max(44, segment.height - 18) : 18,
        },
        warningZone,
      }];
    });
  }

  private canEnterRoom(player: CorePlayer, destinationId: CoreRoomId): boolean {
    const destination = this.rooms.get(destinationId);
    const source = this.rooms.get(player.roomId);
    const destinationTrap = this.specialRooms.get(destinationId);
    if (destinationTrap?.kind === "trap" && ["warning", "wave", "hidden"].includes(destinationTrap.trapPhase ?? "")
      && !destinationTrap.trapParticipants?.includes(player.userId)) return false;
    if (!destination || !source || destination.zone <= this.currentZone) return true;
    if (!this.hasLivingGateInZone(this.currentZone)) return true;
    this.pushZoneGateWarning(player.userId, this.currentZone);
    return false;
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

  private updateResourcePickups(): void {
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      const room = this.rooms.get(player.roomId);
      if (!room || room.kind !== "resource" || this.resourceAccumulators.has(room.id)) continue;
      const center = this.roomWorldCenterOf(room.id);
      if (Math.hypot(player.x - center.x, player.y - center.y) > 64) continue;
      this.resourceAccumulators.set(room.id, 0);
      room.cleared = true;
      this.gold += 15;
    }
  }

  private refreshCurrentZone(): void {
    let zone = this.currentZone;
    for (const player of this.players.values()) {
      const room = this.rooms.get(player.roomId);
      if (room && room.zone > zone) zone = room.zone;
    }
    if (zone <= this.currentZone) return;
    this.currentZone = zone;
    this.clearPreviousZoneCombat(zone);
  }

  private clearPreviousZoneCombat(enteredZone: ZoneId): void {
    for (const state of this.specialRooms.values()) {
      const room = this.rooms.get(state.roomId);
      if (!room || room.zone >= enteredZone || state.kind !== "trap") continue;
      const participants = [...(state.trapParticipants ?? [])];
      state.trapPhase = "cleared";
      state.trapDebuff = undefined;
      state.trapParticipants = [];
      state.trapProgress = 0;
      room.cleared = true;
      for (const playerId of participants) {
        const player = this.players.get(playerId);
        if (player) this.recalculateMaxHp(player, player.maxHp);
      }
    }

    for (const enemy of this.enemies.values()) {
      const spawnRoom = this.rooms.get(enemy.spawnRoomId);
      if (!spawnRoom || spawnRoom.zone >= enteredZone || enemy.kind === "boss") continue;
      enemy.alive = false;
      enemy.hp = 0;
      enemy.respawnRemaining = null;
      enemy.aggroed = false;
      enemy.targetId = null;
      enemy.lastMoveSpeed = 0;
      enemy.transformRevision += 1;
      this.enemyThreat.delete(enemy.id);
      this.returningHiddenEnemies.delete(enemy.id);
      if (spawnRoom.kind === "static-monster" || spawnRoom.kind === "hidden-monster" || spawnRoom.kind === "trap") {
        spawnRoom.cleared = true;
      }
    }
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
}

function segmentIntersectsRect(x1: number, y1: number, x2: number, y2: number, rect: { x: number; y: number; width: number; height: number }): boolean {
  let near = 0;
  let far = 1;
  for (const [origin, delta, min, max] of [
    [x1, x2 - x1, rect.x, rect.x + rect.width],
    [y1, y2 - y1, rect.y, rect.y + rect.height],
  ] as const) {
    if (Math.abs(delta) < 1e-9) {
      if (origin < min || origin > max) return false;
      continue;
    }
    const first = (min - origin) / delta;
    const second = (max - origin) / delta;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
    if (near > far) return false;
  }
  return true;
}

function expandedBarrier(barrier: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
  return {
    x: barrier.x - ACTOR_COLLISION_RADIUS,
    y: barrier.y - ACTOR_COLLISION_RADIUS,
    width: barrier.width + ACTOR_COLLISION_RADIUS * 2,
    height: barrier.height + ACTOR_COLLISION_RADIUS * 2,
  };
}

function movementCrossesBarrier(x1: number, y1: number, x2: number, y2: number, rect: { x: number; y: number; width: number; height: number }): boolean {
  const startsInside = pointInWorldRect(x1, y1, rect);
  const endsInside = pointInWorldRect(x2, y2, rect);
  // A barrier may appear while an entrant still overlaps its collision margin.
  // Let movement escape that margin, but never let a free actor enter or cross it.
  if (startsInside) {
    if (!endsInside) return false;
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    return Math.hypot(x2 - centerX, y2 - centerY) < Math.hypot(x1 - centerX, y1 - centerY);
  }
  return segmentIntersectsRect(x1, y1, x2, y2, rect);
}
