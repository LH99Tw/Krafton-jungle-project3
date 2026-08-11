import type { HeroClassId, PlayerInputCommand } from "@five-days/protocol";
import {
  rollPartyHiddenDrops,
  type EquipmentSlot,
  type PersonalHiddenDrop,
} from "./v02/equipment";
import type { RoomId, ThreeZoneMap, ZoneId } from "./v02/map";
import {
  addAugmentStack,
  addExperience,
  createAugmentDraft,
  MAX_LEVEL,
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
  type TravelIntent,
} from "./v02/simulation";
import { bossWorldRect, roomWorldCenter, roomWorldRect } from "./v02/world";

export * from "./v02";

export type CorePhase = "lobby" | "day" | "night" | "standby" | "boss" | "ended";
export type CoreResult = "victory" | "defeat" | "abandoned";

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
  lastAttackTargetId: string | null;
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
};

export type TeamProgress = Readonly<{
  level: number;
  xp: number;
  xpToNext: number;
}>;

const durations = {
  prototype: { day: 60, night: 25, standby: 5 },
  full: { day: 210, night: 75, standby: 15 },
} as const;

const RESOURCE_PRODUCTION_SECONDS = 5;
const STATIC_RESPAWN_SECONDS = { prototype: 30, full: 90 } as const;
const SIMULATION_EPSILON = 1e-9;

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
  private travelIntent: TravelIntent | null = null;
  private invaderSpawnAccumulator = 0;
  private invaderSerial = 0;
  private hiddenDropSerial = 0;
  private readonly resourceAccumulators = new Map<CoreRoomId, number>();
  private readonly vulnerableEnemies = new Map<string, { playerId: string; expiresAt: number }>();
  private readonly markedEnemies = new Map<string, { playerId: string; expiresAt: number }>();

  constructor(readonly options: GameCoreOptions) {
    this.minimumPlayers = options.minimumPlayers ?? 3;
    const world = createRuntimeWorld(options.seed, options.difficulty);
    this.maps = world.maps;
    this.rooms = world.rooms;
    this.doors = world.doors;
    this.enemies = world.enemies;
    this.waypoints = world.waypoints;
    this.discoverRoom(this.maps.zones[0].startRoomId);
  }

  get teamXpToNext(): number {
    return xpRequiredForNextLevel(this.teamLevel) ?? 0;
  }

  get teamProgress(): TeamProgress {
    return { level: this.teamLevel, xp: this.teamXp, xpToNext: this.teamXpToNext };
  }

  get activeTravel(): Readonly<TravelIntent> | null {
    return this.travelIntent ? { ...this.travelIntent } : null;
  }

  addPlayer(input: { userId: string; displayName: string; heroClass: HeroClassId }): CorePlayer {
    const existing = this.players.get(input.userId);
    if (existing) {
      existing.connected = true;
      return existing;
    }

    const rules = CLASS_COMBAT_RULES[input.heroClass];
    const startRoom = this.maps.zones[0].rooms.find((room) => room.id === this.maps.zones[0].startRoomId);
    const startCenter = roomWorldCenter({ x: startRoom?.x ?? 0, y: startRoom?.y ?? 0 });
    const player: CorePlayer = {
      ...input,
      roomId: this.maps.zones[0].startRoomId,
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
      lastAttackTargetId: null,
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
      const transitioned = movePlayerWorld(
        player,
        player.inputX * rules.speed * delta,
        player.inputY * rules.speed * delta,
        this.rooms,
      );
      if (transitioned) this.discoverRoom(player.roomId);
    }

    if (this.phase === "day" || this.phase === "night" || this.phase === "boss") {
      for (const player of this.players.values()) {
        if (player.connected && player.alive && player.autoAttackCooldown <= 0) this.performAutoAttack(player.userId);
      }
    }
    this.updateStaticEnemies(delta);
    this.updatePatternEnemies(delta);
    this.updateStaticRespawns(delta);
    this.updateInvaders(delta);
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
    const targets = this.enemiesInAttackCone(player, range, cone);
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
    for (const [index, candidate] of targets.slice(0, 1 + additionalTargets).entries()) {
      const secondaryMultiplier = index === 0 ? 1 : player.heroClass === "mage" ? 0.6 : 0.65;
      this.damageEnemy(userId, candidate.id, this.calculateAttackDamage(player, candidate) * secondaryMultiplier);
    }
    return target;
  }

  castSkill(userId: string, skillId: "q" | "e" | "dash", aim: number): boolean {
    const player = this.players.get(userId);
    if (!player || !player.alive || this.phase === "lobby" || this.phase === "ended") return false;
    player.aim = aim;
    if (skillId === "dash") {
      if (player.dashCooldown > 0) return false;
      player.dashCooldown = 5;
      movePlayerWorld(player, Math.cos(aim) * 145, Math.sin(aim) * 145, this.rooms);
      return true;
    }
    const cooldownKey = skillId === "q" ? "qCooldown" : "eCooldown";
    if (player[cooldownKey] > 0) return false;
    const cooldownReduction = Math.min(0.6, (player.upgrades["skill-haste"] ?? 0) * 0.06
      + (player.heroClass === "mage" && player.upgrades["mage-tempo"] ? 0.25 : 0));
    player[cooldownKey] = (skillId === "q" ? 5 : 7) * (1 - cooldownReduction);
    const skillPower = 1 + (player.upgrades["skill-power"] ?? 0) * 0.22;
    const areaMultiplier = 1 + (player.upgrades["area-power"] ?? 0) * 0.12
      + (player.heroClass === "mage" && player.upgrades["mage-nova"] ? 0.55 : 0);
    const range = 260 * areaMultiplier;
    const targets = this.enemiesInAttackCone(player, range, Math.PI * 0.72);
    const baseDamage = (CLASS_COMBAT_RULES[player.heroClass].attackDamage + equipmentBonuses(player.equipment).attackBonus + augmentAttackBonus(player.upgrades))
      * (skillId === "q" ? 2.1 : 1.65) * skillPower;
    for (const target of targets) {
      this.damageEnemy(userId, target.id, baseDamage);
      if (player.heroClass === "swordsman" && player.upgrades["swordsman-rupture"]) {
        this.vulnerableEnemies.set(target.id, { playerId: userId, expiresAt: this.elapsed + 3 });
      }
      if (player.heroClass === "archer" && player.upgrades["archer-mark"]) {
        this.markedEnemies.set(target.id, { playerId: userId, expiresAt: this.elapsed + 5 });
      }
      if (player.heroClass === "mage" && player.upgrades["mage-echo"] && target.alive) {
        this.damageEnemy(userId, target.id, baseDamage * 0.55);
      }
    }
    return true;
  }

  damageEnemy(userId: string, enemyId: string, rawDamage?: number): boolean {
    const player = this.players.get(userId);
    const enemy = this.enemies.get(enemyId);
    if (!player || !enemy || !player.alive || !enemy.alive || player.roomId !== enemy.roomId) return false;
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
    const destinationRoom = this.rooms.get(destination);
    const center = destinationRoom
      ? roomWorldCenter({ x: destinationRoom.gridX, y: destinationRoom.gridY })
      : { x: ROOM_WIDTH / 2, y: ROOM_HEIGHT / 2 };
    player.roomId = destination;
    player.x = center.x;
    player.y = center.y;
    this.discoverRoom(destination);
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
    const baseWaypointId = waypointId(this.maps.zones[0].startRoomId, "start");
    if (source.id === baseWaypointId) return false;
    return this.beginTravel(userId, source, baseWaypointId);
  }

  movePlayerToRoom(userId: string, roomId: CoreRoomId, _x?: number, _y?: number): boolean {
    const player = this.players.get(userId);
    const room = this.rooms.get(roomId);
    if (!player || !room) return false;
    const center = roomWorldCenter({ x: room.gridX, y: room.gridY });
    player.roomId = roomId;
    player.x = center.x;
    player.y = center.y;
    this.discoverRoom(roomId);
    this.refreshCurrentZone();
    return true;
  }

  spawnInvader(zone: ZoneId = this.currentZone): CoreEnemy {
    const invader = createInvaderEnemy(
      this.options.seed,
      zone,
      this.invaderSerial,
      this.maps,
      this.options.difficulty,
    );
    this.invaderSerial += 1;
    this.enemies.set(invader.id, invader);
    return invader;
  }

  startBoss(): boolean {
    if (this.phase === "ended" || this.day < 3) return false;
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

  private transition(phase: "day" | "night" | "standby"): void {
    this.phase = phase;
    this.phaseRemaining = durations[this.options.mode][phase];
    if (phase !== "night") this.invaderSpawnAccumulator = 0;
  }

  private calculateAttackDamage(player: CorePlayer, enemy: CoreEnemy): number {
    const rules = CLASS_COMBAT_RULES[player.heroClass];
    let damage = rules.attackDamage + equipmentBonuses(player.equipment).attackBonus + augmentAttackBonus(player.upgrades);
    const criticalChance = (player.upgrades.precision ?? 0) * 0.06;
    if (deterministicCombatRoll(this.options.seed, player.userId, player.attackCount) < criticalChance) {
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
    return [...this.enemies.values()]
      .filter((enemy) => enemy.alive && enemy.roomId === player.roomId)
      .map((enemy) => ({
        enemy,
        distance: Math.hypot(enemy.x - player.x, enemy.y - player.y),
        angularError: Math.abs(Math.atan2(
          Math.sin(Math.atan2(enemy.y - player.y, enemy.x - player.x) - player.aim),
          Math.cos(Math.atan2(enemy.y - player.y, enemy.x - player.x) - player.aim),
        )),
      }))
      .filter(({ distance, angularError }) => distance <= range && angularError <= coneHalfAngle)
      .sort((left, right) => left.distance - right.distance || left.enemy.id.localeCompare(right.enemy.id))
      .map(({ enemy }) => enemy);
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
      this.unlockGateWaypoint(enemy.spawnRoomId as RoomId);
    } else if (enemy.kind === "hidden") {
      this.rewardHiddenRoom(enemy.spawnRoomId as RoomId);
    } else if (enemy.kind === "boss") {
      const room = this.rooms.get(BOSS_ROOM_ID);
      if (room) room.cleared = true;
      this.finish("victory", "마왕을 쓰러뜨리고 왕국을 지켜냈습니다.");
    }

    const room = this.rooms.get(enemy.spawnRoomId);
    if (room && ![...this.enemies.values()].some((candidate) =>
      candidate.alive && candidate.spawnRoomId === room.id && candidate.kind !== "invader")) {
      room.cleared = true;
    }
  }

  private rewardHiddenRoom(roomId: RoomId): void {
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

  private placeDrop(item: PersonalHiddenDrop, roomId: RoomId): void {
    const room = this.rooms.get(roomId);
    const center = room ? roomWorldCenter({ x: room.gridX, y: room.gridY }) : { x: ROOM_WIDTH / 2, y: ROOM_HEIGHT / 2 };
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
    if (roomId === BOSS_ROOM_ID) return;
    for (const waypoint of this.waypoints.values()) {
      if (waypoint.roomId === roomId && (waypoint.kind === "start" || waypoint.kind === "central")) {
        waypoint.active = true;
      }
    }
  }

  private unlockGateWaypoint(gateRoomId: RoomId): void {
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
    if (destinationId === BOSS_ROOM_ID) {
      const boss = bossWorldRect();
      for (const player of players) {
        player.roomId = BOSS_ROOM_ID;
        player.x = boss.x + boss.width / 2;
        player.y = boss.y + boss.height * 0.72;
      }
      this.discoverRoom(BOSS_ROOM_ID);
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
    for (const player of players) {
      player.roomId = destination.roomId;
      player.x = destination.x;
      player.y = destination.y;
    }
    this.discoverRoom(destination.roomId);
    this.currentZone = destination.zone;
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
      enemy.respawnRemaining = null;
      const room = this.rooms.get(enemy.spawnRoomId);
      if (room) room.cleared = false;
    }
  }

  private damagePlayer(player: CorePlayer, rawDamage: number): void {
    const defense = equipmentBonuses(player.equipment).defenseBonus;
    player.hp = Math.max(0, player.hp - Math.max(1, Math.round(rawDamage - defense)));
    if (player.hp > 0) return;
    player.alive = false;
    player.inputX = 0;
    player.inputY = 0;
    player.deaths += 1;
    if (![...this.players.values()].some((candidate) => candidate.alive)) {
      this.finish("defeat", "용사 파티가 전멸했습니다.");
    }
  }

  private updateInvaders(delta: number): void {
    for (const enemy of this.enemies.values()) {
      if (!enemy.alive || enemy.behavior !== "invader") continue;
      enemy.targetId = "base";
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - delta);
      // Coarse room-level advance toward the base every 2.5s.
      enemy.coarseProgress += delta;
      while (enemy.coarseProgress + SIMULATION_EPSILON >= 2.5 && enemy.alive) {
        enemy.coarseProgress -= 2.5;
        if (enemy.pathIndex + 1 < enemy.path.length) {
          enemy.pathIndex += 1;
          enemy.roomId = enemy.path[enemy.pathIndex] as CoreRoomId;
        } else {
          this.damageBase(enemy.damage);
          enemy.alive = false;
          break;
        }
      }
      // Smoothly walk toward the current path room's world center so the
      // client renders the invader physically advancing through the world.
      const target = this.roomWorldCenterOf(enemy.path[enemy.pathIndex] as CoreRoomId);
      const dx = target.x - enemy.x;
      const dy = target.y - enemy.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 4 && enemy.alive) {
        const step = Math.min(distance, enemy.speed * delta);
        enemy.x += dx / distance * step;
        enemy.y += dy / distance * step;
      }
    }
  }

  private updateInvaderSpawning(delta: number): void {
    if (this.phase === "lobby" || this.phase === "ended") return;
    const isNight = this.phase === "night";
    const baseInterval = isNight ? 6 : 14;
    const interval = Math.max(3, baseInterval - this.day);
    this.invaderSpawnAccumulator += delta;
    if (this.invaderSpawnAccumulator < interval) return;
    this.invaderSpawnAccumulator = 0;
    const count = isNight ? 2 + Math.floor(this.day / 2) : 1;
    for (let index = 0; index < count; index += 1) this.spawnInvader(this.currentZone);
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
    const room = this.rooms.get(roomId);
    if (room) return roomWorldCenter({ x: room.gridX, y: room.gridY });
    return { x: 0, y: 0 };
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
        if (player.aiRole) { player.inputX = 0; player.inputY = 0; }
        continue;
      }
      if (this.phase === "lobby" || this.phase === "ended") { player.inputX = 0; player.inputY = 0; continue; }
      const leader = this.aiLeader(player);
      const targetRoom = player.aiRole === "defender"
        ? this.rooms.get(this.maps.zones[0].startRoomId)
        : leader ? this.rooms.get(leader.roomId) : null;
      if (!targetRoom) { player.inputX = 0; player.inputY = 0; continue; }
      if (player.roomId === targetRoom.id) {
        const anchor = player.aiRole === "follower" && leader
          ? { x: leader.x, y: leader.y }
          : this.roomWorldCenterOf(targetRoom.id);
        this.aiApproach(player, anchor.x, anchor.y, player.aiRole === "follower" ? 76 : 40);
      } else {
        const nextRoom = this.nextRoomToward(player.roomId, targetRoom.id);
        const anchor = nextRoom ? this.roomWorldCenterOf(nextRoom) : this.roomWorldCenterOf(targetRoom.id);
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
    const dx = x - enemy.x;
    const dy = y - enemy.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= 0) return;
    const step = Math.min(distance, enemy.speed * delta);
    const room = this.rooms.get(enemy.spawnRoomId);
    const bounds = room ? roomWorldRect({ x: room.gridX, y: room.gridY }) : null;
    const nextX = enemy.x + dx / distance * step;
    const nextY = enemy.y + dy / distance * step;
    enemy.x = bounds ? clamp(nextX, bounds.x, bounds.x + bounds.width) : nextX;
    enemy.y = bounds ? clamp(nextY, bounds.y, bounds.y + bounds.height) : nextY;
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
    this.currentZone = zone;
  }
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
