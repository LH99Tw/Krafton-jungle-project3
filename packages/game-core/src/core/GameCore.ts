import { PROTOCOL_VERSION, type CombatAttackEvent, type HeroClassId, type PlayerInputCommand } from "@five-days/protocol";
import { rollPartyHiddenDrops, type EquipmentSlot, type PersonalHiddenDrop } from "../v02/equipment";
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
  resolveWalkableDiscPoint,
  roomWorldRect,
  type WorldRect,
  type WalkableSpatialIndex,
} from "../v02/world";
import { ACTOR_COLLISION_RADIUS, RESOURCE_PRODUCTION_SECONDS, SIMULATION_EPSILON, STATIC_RESPAWN_SECONDS, durations } from "./constants";
import { aiAugmentScore, clamp, deterministicCombatRoll, invaderEdgeKey, pointInWorldRect, shouldAiYieldEquipment } from "./helpers";
import { createAuthoredRuntimeWorld } from "./world-build";
import { AiPlayersDirector } from "./systems/AiPlayersDirector";
import { InvaderDirector } from "./systems/InvaderDirector";
import { TravelDirector } from "./systems/TravelDirector";
import type { CoreCombatStats, CoreNotice, CorePhase, CorePlayer, CoreResult, GameCoreOptions, InvaderSimulationTiers, TeamProgress } from "./types";

const authoredWalkableWithoutBossCache = new WeakMap<CoreWorldDefinition, readonly WorldRect[]>();

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
  private combatAttackEventCount = 0;
  private readonly combatAttackEvents: CombatAttackEvent[] = [];
  private readonly resourceAccumulators = new Map<CoreRoomId, number>();
  private readonly vulnerableEnemies = new Map<string, { playerId: string; expiresAt: number }>();
  private readonly markedEnemies = new Map<string, { playerId: string; expiresAt: number }>();
  private readonly authoredRoomCells = new Map<number, Map<number, CoreRoomId[]>>();
  private readonly roomRects = new Map<CoreRoomId, WorldRect>();
  private readonly roomCenters = new Map<CoreRoomId, Readonly<{ x: number; y: number }>>();
  private readonly routeCache = new Map<string, readonly CoreRoomId[]>();
  private authoredWalkableCache: { bossAccessible: boolean; rects: readonly WorldRect[] } | null = null;
  private readonly notices: CoreNotice[] = [];
  private readonly noticeCooldowns = new Map<string, number>();

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

  /** @internal work accounting merged from the invader director and combat pipeline. */
  get invaderWorkMetrics(): Readonly<{
    microSpawned: number;
    pendingReplans: number;
    completedReplans: number;
    oldestPendingWaveSeconds: number;
    combatAttackEvents: number;
    compensatedAttacks: number;
  }> {
    const work = this.invaderDirector.workMetrics;
    return {
      ...work,
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
    this.aiPlayersDirector.update();

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
    this.invaderDirector.update(delta);
    this.invaderDirector.retireInactive();
    this.invaderDirector.updateSpawning(delta);
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
    const rules = CLASS_COMBAT_RULES[player.heroClass];
    const rangeMultiplier = 1 + (player.upgrades["area-power"] ?? 0) * 0.12
      + (player.heroClass === "swordsman" ? (player.upgrades.multishot ?? 0) * 0.2 : 0);
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
    const haste = (player.upgrades.haste ?? 0) * 0.12;
    const equipmentHaste = equipmentBonuses(player.equipment).attackSpeedBonus / 100;
    player.autoAttackCooldown = Math.max(0.12, rules.attackInterval / (1 + haste + equipmentHaste));
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

  castSkill(userId: string, skillId: "q" | "e" | "dash", aim: number): boolean {
    const player = this.players.get(userId);
    if (!player || !player.alive || this.phase === "lobby" || this.phase === "ended") return false;
    player.aim = aim;
    if (skillId === "dash") {
      if (player.dashCooldown > 0) return false;
      player.dashCooldown = 5;
      player.skillSequence += 1;
      player.lastSkillId = "dash";
      player.skillOriginX = player.x;
      player.skillOriginY = player.y;
      this.movePlayer(player, Math.cos(aim) * 145, Math.sin(aim) * 145);
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
    const haste = (player.upgrades.haste ?? 0) * 0.12 + equipment.attackSpeedBonus / 100;
    const rangeMultiplier = 1 + (player.upgrades["area-power"] ?? 0) * 0.12
      + (player.heroClass === "swordsman" ? (player.upgrades.multishot ?? 0) * 0.2 : 0);
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

  private transition(phase: "day" | "night" | "standby"): void {
    this.phase = phase;
    this.phaseRemaining = durations[this.options.mode][phase];
    this.invaderDirector.resetWaveProgress();
  }

  private calculateAttackDamage(player: CorePlayer, enemy: CoreEnemy): number {
    const rules = CLASS_COMBAT_RULES[player.heroClass];
    let damage = rules.attackDamage + equipmentBonuses(player.equipment).attackBonus + augmentAttackBonus(player.upgrades);
    const criticalChance = (player.upgrades.precision ?? 0) * 0.06;
    const critical = deterministicCombatRoll(this.options.seed, player.userId, player.attackCount) < criticalChance;
    player.lastAttackCritical = critical;
    if (critical) {
      damage *= 1.5 + (player.upgrades.ferocity ?? 0) * 0.2;
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
    enemy.patternPhase = "idle";
    enemy.patternRemaining = 0;
    enemy.respawnRemaining = enemy.kind === "static" ? STATIC_RESPAWN_SECONDS[this.options.mode] : null;
    killer.kills += 1;
    this.gold += enemy.goldReward;
    if (enemy.xpReward > 0) this.addTeamExperience(enemy.xpReward);

    if (enemy.kind === "gate") {
      killer.gatesDestroyed += 1;
      this.travelDirector.unlockGate(enemy.spawnRoomId);
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
