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
  inputX: number;
  inputY: number;
  equipment: CoreEquipmentLoadout;
  upgrades: AugmentStacks;
  upgradeDraft: CoreUpgradeDraft | null;
  pendingUpgradeLevels: number[];
  draftIndex: number;
  autoAttackCooldown: number;
  attackCount: number;
  damage: number;
  bossDamage: number;
  kills: number;
  deaths: number;
  structuresBuilt: number;
  goldSpent: number;
  gatesDestroyed: number;
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
      inputX: 0,
      inputY: 0,
      equipment: createEmptyEquipment(),
      upgrades: {},
      upgradeDraft: null,
      pendingUpgradeLevels: [],
      draftIndex: 0,
      autoAttackCooldown: 0,
      attackCount: 0,
      damage: 0,
      bossDamage: 0,
      kills: 0,
      deaths: 0,
      structuresBuilt: 0,
      goldSpent: 0,
      gatesDestroyed: 0,
    };
    for (let level = 2; level <= this.teamLevel; level += 1) player.pendingUpgradeLevels.push(level);
    this.players.set(input.userId, player);
    this.activateNextDraft(player);
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
    return true;
  }

  update(deltaSeconds: number): void {
    if (this.phase === "lobby" || this.phase === "ended") return;
    const delta = Math.max(0, Math.min(0.1, deltaSeconds));
    this.elapsed += delta;

    for (const player of this.players.values()) {
      player.autoAttackCooldown = Math.max(0, player.autoAttackCooldown - delta);
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
    const target = selectNearestConeEnemy(
      player,
      this.enemies.values(),
      rules.attackRange * rangeMultiplier,
      rules.coneHalfAngle,
    );
    if (!target) return null;

    player.attackCount += 1;
    const haste = (player.upgrades.haste ?? 0) * 0.12;
    const equipmentHaste = equipmentBonuses(player.equipment).attackSpeedBonus / 100;
    player.autoAttackCooldown = Math.max(0.12, rules.attackInterval / (1 + haste + equipmentHaste));
    this.damageEnemy(userId, target.id, this.calculateAttackDamage(player, target));
    return target;
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
    if (["hidden", "gate", "boss"].includes(enemy.kind)) damage *= 1 + (player.upgrades["boss-hunter"] ?? 0) * 0.12;
    if (player.heroClass === "swordsman" && player.upgrades["swordsman-execution"] && enemy.hp / enemy.maxHp <= 0.3) {
      damage *= 1.6;
    }
    if (player.heroClass === "archer" && player.upgrades["archer-sniper"]) {
      const distance = Math.hypot(enemy.x - player.x, enemy.y - player.y);
      damage *= 1 + Math.min(0.55, Math.max(0, (distance - 180) / 280) * 0.55);
    }
    return Math.max(1, Math.round(damage));
  }

  private killEnemy(killer: CorePlayer, enemy: CoreEnemy): void {
    enemy.alive = false;
    enemy.hp = 0;
    enemy.aggroed = false;
    enemy.targetId = null;
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
      const current = player.equipment[item.slot];
      if (equipmentPower(item) > equipmentPower(current)) this.equipItem(player, item);
      else {
        const room = this.rooms.get(roomId);
        const center = room ? roomWorldCenter({ x: room.gridX, y: room.gridY }) : { x: ROOM_WIDTH / 2, y: ROOM_HEIGHT / 2 };
        this.drops.set(item.id, {
          ...item,
          roomId,
          x: center.x,
          y: center.y,
          claimed: false,
        });
      }
    }
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
    return [...this.players.values()].filter((player) => player.connected && player.alive);
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
      this.completeTravel(intent.destinationId, eligible);
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
      if (!enemy.alive || enemy.behavior !== "static") continue;
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - delta);
      if (!enemy.aggroed) continue;
      const target = enemy.targetId ? this.players.get(enemy.targetId) : undefined;
      if (!target || !target.alive || target.roomId !== enemy.spawnRoomId) {
        this.moveEnemyToward(enemy, enemy.spawnX, enemy.spawnY, delta);
        if (Math.hypot(enemy.x - enemy.spawnX, enemy.y - enemy.spawnY) < 2) {
          enemy.aggroed = false;
          enemy.targetId = null;
        }
        continue;
      }

      const distance = Math.hypot(target.x - enemy.x, target.y - enemy.y);
      if (distance > enemy.attackRange) this.moveEnemyToward(enemy, target.x, target.y, delta);
      else if (enemy.attackCooldown <= 0) {
        this.damagePlayer(target, enemy.damage);
        enemy.attackCooldown = 0.9;
      }
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
      enemy.respawnRemaining = null;
      const room = this.rooms.get(enemy.spawnRoomId);
      if (room) room.cleared = false;
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
    enemy.roomId = enemy.spawnRoomId;
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
      enemy.coarseProgress += delta;
      while (enemy.coarseProgress + SIMULATION_EPSILON >= 2.5 && enemy.alive) {
        enemy.coarseProgress -= 2.5;
        if (enemy.pathIndex + 1 < enemy.path.length) {
          enemy.pathIndex += 1;
          enemy.roomId = enemy.path[enemy.pathIndex] as CoreRoomId;
        } else {
          this.baseHp = Math.max(0, this.baseHp - enemy.damage);
          enemy.alive = false;
          if (this.baseHp === 0) this.finish("defeat", "베이스 캠프가 파괴되었습니다.");
        }
      }
    }
  }

  private updateInvaderSpawning(delta: number): void {
    if (this.phase !== "night") return;
    this.invaderSpawnAccumulator += delta;
    if (this.invaderSpawnAccumulator < 8) return;
    this.invaderSpawnAccumulator -= 8;
    const zone = this.currentZone;
    this.spawnInvader(zone);
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
