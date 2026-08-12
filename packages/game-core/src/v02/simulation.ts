import type { HeroClassId } from "@five-days/protocol";
import {
  EQUIPMENT_RARITIES,
  type EquipmentSlot,
  type PersonalHiddenDrop,
} from "./equipment";
import {
  generateThreeZoneMap,
  type RoomId,
  type RoomType,
  type ThreeZoneMap,
  type ZoneId,
  type ZoneMap,
} from "./map";
import type { AugmentDefinition, AugmentStacks } from "./progression";
import { createSeededRandom, hashSeed } from "./random";
import {
  bossWorldRect,
  buildWorldFromRooms,
  roomContainingPoint,
  roomIdToGrid,
  roomWorldCenter,
  roomWorldRect,
  resolveWalkablePoint,
  type WorldRect,
} from "./world";

export const ROOM_WIDTH = 1_280;
export const ROOM_HEIGHT = 720;
export const ROOM_EDGE_INSET = 28;
export const WAYPOINT_RADIUS = 92;
export const WAYPOINT_HOLD_SECONDS = 5;
export const FAST_TRAVEL_HOLD_SECONDS = 3;
export const BOSS_ROOM_ID = "boss:arena" as const;

export type AuthoredRoomId = `editor:${string}`;
export type CoreRoomId = RoomId | typeof BOSS_ROOM_ID | AuthoredRoomId;
export type SpecialRoomKind = "shop" | "shrine" | "trap" | "checkpoint" | "gamble" | "altar" | "gold";
export type CoreRoomKind = RoomType | "boss" | "gate-candidate" | SpecialRoomKind;
export type CoreEnemyKind = "static" | "hidden" | "gate" | "invader" | "boss";
export type CoreEnemyBehavior = "static" | "gate" | "invader" | "boss";
export type EnemyPatternKind = "fan" | "floor";
export type EnemyPatternPhase = "idle" | "telegraph";
export type CoreWaypointKind = "start" | "central" | "checkpoint" | "gate" | "boss";

export type CoreRoom = {
  id: CoreRoomId;
  zone: ZoneId;
  gridX: number;
  gridY: number;
  kind: CoreRoomKind;
  depth: number;
  connections: readonly CoreRoomId[];
  discovered: boolean;
  cleared: boolean;
  rect?: WorldRect;
};

export type CoreWorldConnectionDefinition = Readonly<{
  id: string;
  from: AuthoredRoomId;
  to: AuthoredRoomId;
  floorRects: readonly WorldRect[];
  points: readonly Readonly<{ x: number; y: number }>[];
  portal: Readonly<{ x: number; y: number }>;
  /** Canonical progression barrier shared by authoritative collision and rendering. */
  lockBarrier?: WorldRect;
  /** Doorway barrier used only while a connected trap room is locked down. */
  trapBarrier?: WorldRect;
}>;

/** Geometry-neutral authored world consumed by the same GameCore used on Colyseus. */
export type CoreWorldDefinition = Readonly<{
  kind: "authored";
  id: string;
  rooms: readonly Readonly<{
    id: AuthoredRoomId;
    zone: ZoneId;
    kind: CoreRoomKind;
    rect: WorldRect;
    mapX: number;
    mapY: number;
    connections: readonly AuthoredRoomId[];
    depth: number;
  }>[];
  connections: readonly CoreWorldConnectionDefinition[];
  walkable: readonly WorldRect[];
  bounds: WorldRect;
  baseRoomId: AuthoredRoomId;
  bossRoomId: AuthoredRoomId;
  gateRoomIds: readonly AuthoredRoomId[];
  gateCandidateRoomIds?: readonly AuthoredRoomId[];
}>;

export type CoreDoor = {
  id: string;
  zone: ZoneId;
  fromRoomId: CoreRoomId;
  toRoomId: CoreRoomId;
  open: boolean;
  locked: boolean;
};

export type CoreEnemy = {
  id: string;
  kind: CoreEnemyKind;
  behavior: CoreEnemyBehavior;
  roomId: CoreRoomId;
  spawnRoomId: CoreRoomId;
  x: number;
  y: number;
  spawnX: number;
  spawnY: number;
  hp: number;
  maxHp: number;
  damage: number;
  speed: number;
  attackRange: number;
  attackCooldown: number;
  xpReward: number;
  goldReward: number;
  alive: boolean;
  aggroed: boolean;
  targetId: string | null;
  lastHitBy: string | null;
  path: readonly CoreRoomId[];
  pathIndex: number;
  coarseProgress: number;
  /** Remaining deterministic simulation seconds before a normal static respawn. */
  respawnRemaining: number | null;
  patternKind: EnemyPatternKind;
  patternPhase: EnemyPatternPhase;
  patternRemaining: number;
  patternIndex: number;
  attackSequence: number;
  /** Monotonic revision used by the server's delta transform channel. */
  transformRevision: number;
  /** Most recently resolved authoritative movement speed in pixels/second. */
  lastMoveSpeed: number;
};

export type CoreWaypoint = {
  id: string;
  roomId: CoreRoomId;
  zone: ZoneId;
  kind: CoreWaypointKind;
  x: number;
  y: number;
  destinationId: string;
  active: boolean;
  requiredPlayers: number;
  holdingPlayers: number;
  holdProgress: number;
  holdDurationMs: number;
};

export type CoreDrop = PersonalHiddenDrop & {
  roomId: CoreRoomId;
  x: number;
  y: number;
  claimed: boolean;
};

export type CoreEquipmentLoadout = Record<EquipmentSlot, PersonalHiddenDrop | null>;
export const PERSONAL_INVENTORY_SIZE = 6;

export type CoreEquipmentBonuses = {
  attackBonus: number;
  maxHpBonus: number;
  defenseBonus: number;
  attackSpeedBonus: number;
};

export type CoreUpgradeDraft = {
  draftId: string;
  level: number;
  active: true;
  expiresAt: 0;
  choices: readonly AugmentDefinition[];
};

export type SimulationPlayer = {
  userId: string;
  heroClass: HeroClassId;
  roomId: CoreRoomId;
  x: number;
  y: number;
  aim: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  connected: boolean;
  equipment: CoreEquipmentLoadout;
  upgrades: AugmentStacks;
};

export type RuntimeWorld = {
  maps: ThreeZoneMap;
  rooms: Map<CoreRoomId, CoreRoom>;
  doors: Map<string, CoreDoor>;
  enemies: Map<string, CoreEnemy>;
  waypoints: Map<string, CoreWaypoint>;
};

export type TravelIntent = {
  requestedBy: string;
  waypointId: string;
  destinationId: string;
  elapsed: number;
  personal: boolean;
};

export type ClassCombatRule = {
  hp: number;
  speed: number;
  power: number;
  attackDamage: number;
  attackRange: number;
  attackInterval: number;
  coneHalfAngle: number;
};

export const PLAYER_MOVE_SPEED_MULTIPLIER = 1.2;
export const MONSTER_MOVE_SPEED = 280;

export const CLASS_COMBAT_RULES: Readonly<Record<HeroClassId, ClassCombatRule>> = {
  swordsman: {
    hp: 150,
    speed: 230 * PLAYER_MOVE_SPEED_MULTIPLIER,
    power: 115,
    attackDamage: 11,
    attackRange: 118,
    attackInterval: 0.44,
    coneHalfAngle: Math.PI * 55 / 180,
  },
  archer: {
    hp: 105,
    speed: 255 * PLAYER_MOVE_SPEED_MULTIPLIER,
    power: 120,
    attackDamage: 7,
    attackRange: 460,
    attackInterval: 0.36,
    coneHalfAngle: Math.PI / 6,
  },
  mage: {
    hp: 95,
    speed: 240 * PLAYER_MOVE_SPEED_MULTIPLIER,
    power: 125,
    attackDamage: 9,
    attackRange: 390,
    attackInterval: 0.62,
    coneHalfAngle: Math.PI / 6,
  },
};

const DIFFICULTY_MULTIPLIER = {
  easy: { hp: 0.82, damage: 0.78 },
  normal: { hp: 1, damage: 1 },
  hard: { hp: 1.25, damage: 1.18 },
} as const;

const ENEMY_RULES: Readonly<Record<Exclude<CoreEnemyKind, "invader" | "boss">, {
  hp: number;
  damage: number;
  speed: number;
  attackRange: number;
  xp: number;
  gold: number;
}>> = {
  static: { hp: 34, damage: 7, speed: MONSTER_MOVE_SPEED, attackRange: 38, xp: 18, gold: 5 },
  hidden: { hp: 450, damage: 16, speed: MONSTER_MOVE_SPEED, attackRange: 165, xp: 120, gold: 45 },
  gate: { hp: 190, damage: 18, speed: 55, attackRange: 250, xp: 75, gold: 24 },
};

export function createRuntimeWorld(
  seed: string | number,
  difficulty: "easy" | "normal" | "hard",
): RuntimeWorld {
  const maps = generateThreeZoneMap(seed);
  const rooms = new Map<CoreRoomId, CoreRoom>();
  const doors = new Map<string, CoreDoor>();
  const enemies = new Map<string, CoreEnemy>();
  const waypoints = new Map<string, CoreWaypoint>();

  for (const zoneMap of maps.zones) {
    for (const room of zoneMap.rooms) {
      rooms.set(room.id, {
        id: room.id,
        zone: room.zone,
        gridX: room.x,
        gridY: room.y,
        kind: room.type,
        depth: room.depthScore,
        connections: room.connections,
        discovered: room.id === maps.zones[0].startRoomId,
        cleared: room.type === "start" || room.type === "empty" || room.type === "central-waypoint",
      });
      for (const connection of room.connections) {
        if (room.id.localeCompare(connection) >= 0) continue;
        const id = doorId(room.id, connection);
        doors.set(id, {
          id,
          zone: room.zone,
          fromRoomId: room.id,
          toRoomId: connection,
          open: true,
          locked: false,
        });
      }

      const kind = enemyKindForRoom(room.type);
      if (kind) {
        const origin = roomWorldRect({ x: room.x, y: room.y });
        const enemy = createSeededRoomEnemy(seed, room.id, room.zone, kind, difficulty, origin.x, origin.y);
        enemies.set(enemy.id, enemy);
      }
    }
    createZoneWaypoints(zoneMap, waypoints);
  }

  rooms.set(BOSS_ROOM_ID, {
    id: BOSS_ROOM_ID,
    zone: 3,
    gridX: 5,
    gridY: 0,
    kind: "boss",
    depth: 0,
    connections: [],
    discovered: false,
    cleared: false,
  });

  return { maps, rooms, doors, enemies, waypoints };
}

export function createBossEnemy(seed: string | number, difficulty: "easy" | "normal" | "hard"): CoreEnemy {
  const multiplier = DIFFICULTY_MULTIPLIER[difficulty];
  const hp = Math.round(950 * multiplier.hp);
  const boss = bossWorldRect();
  const x = boss.x + boss.width / 2;
  const y = boss.y + boss.height * 0.3;
  return {
    id: `enemy:boss:${hashSeed(`boss:${seed}`).toString(16)}`,
    kind: "boss",
    behavior: "boss",
    roomId: BOSS_ROOM_ID,
    spawnRoomId: BOSS_ROOM_ID,
    x,
    y,
    spawnX: x,
    spawnY: y,
    hp,
    maxHp: hp,
    damage: Math.round(28 * multiplier.damage),
    speed: 0,
    attackRange: 0,
    attackCooldown: 0,
    xpReward: 0,
    goldReward: 0,
    alive: true,
    aggroed: false,
    targetId: null,
    lastHitBy: null,
    path: [],
    pathIndex: 0,
    coarseProgress: 0,
    respawnRemaining: null,
    patternKind: "fan",
    patternPhase: "idle",
    patternRemaining: 0,
    patternIndex: 0,
    attackSequence: 0,
    transformRevision: 0,
    lastMoveSpeed: 0,
  };
}

export function createInvaderEnemy(
  seed: string | number,
  zone: ZoneId,
  spawnIndex: number,
  maps: ThreeZoneMap,
  difficulty: "easy" | "normal" | "hard",
  authored?: Readonly<{ roomId: CoreRoomId; path: readonly CoreRoomId[]; position: Readonly<{ x: number; y: number }> }>,
): CoreEnemy {
  const random = createSeededRandom(`invader:${seed}:${zone}:${spawnIndex}`);
  const multiplier = DIFFICULTY_MULTIPLIER[difficulty];
  const path = authored?.path ?? createInvaderPath(zone, maps);
  const hp = Math.round((22 + zone * 8) * multiplier.hp);
  const spawn = authored?.position ?? invaderWorldSpawn(path[0], maps);
  return {
    id: `enemy:invader:${zone}:${spawnIndex}:${hashSeed(`${seed}:${random.next()}`).toString(16)}`,
    kind: "invader",
    behavior: "invader",
    roomId: authored?.roomId ?? path[0] as CoreRoomId,
    spawnRoomId: authored?.roomId ?? path[0] as CoreRoomId,
    x: spawn.x,
    y: spawn.y,
    spawnX: spawn.x,
    spawnY: spawn.y,
    hp,
    maxHp: hp,
    damage: Math.round((7 + zone * 2) * multiplier.damage),
    speed: MONSTER_MOVE_SPEED,
    attackRange: 42,
    attackCooldown: 0,
    xpReward: 10 + zone * 3,
    goldReward: 4 + zone,
    alive: true,
    aggroed: false,
    targetId: "base",
    lastHitBy: null,
    path,
    pathIndex: 0,
    coarseProgress: 0,
    respawnRemaining: null,
    patternKind: "fan",
    patternPhase: "idle",
    patternRemaining: 0,
    patternIndex: 0,
    attackSequence: 0,
    transformRevision: 0,
    lastMoveSpeed: 0,
  };
}

function invaderWorldSpawn(roomId: CoreRoomId, maps: ThreeZoneMap): Readonly<{ x: number; y: number }> {
  for (const zoneMap of maps.zones) {
    const room = zoneMap.rooms.find((candidate) => candidate.id === roomId);
    if (room) return roomWorldCenter({ x: room.x, y: room.y });
  }
  return roomWorldCenter({ x: 0, y: 0 });
}

/** Gate-to-start paths are concatenated from the spawn zone down to zone one. */
export function createInvaderPath(zone: ZoneId, maps: ThreeZoneMap): readonly CoreRoomId[] {
  const result: CoreRoomId[] = [];
  for (let current = zone; current >= 1; current -= 1) {
    const zoneMap = maps.zones[current - 1] as ZoneMap;
    const segment = shortestRoomPath(zoneMap, zoneMap.gateRoomId, zoneMap.startRoomId);
    if (result.length > 0 && result[result.length - 1] === segment[0]) result.push(...segment.slice(1));
    else result.push(...segment);
  }
  return result;
}

export function shortestRoomPath(map: ZoneMap, from: RoomId, to: RoomId): RoomId[] {
  const previous = new Map<RoomId, RoomId | null>([[from, null]]);
  const queue: RoomId[] = [from];
  while (queue.length > 0) {
    const current = queue.shift() as RoomId;
    if (current === to) break;
    const room = map.rooms.find((candidate) => candidate.id === current);
    for (const next of room?.connections ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, current);
      queue.push(next);
    }
  }
  if (!previous.has(to)) throw new Error(`No path from ${from} to ${to}`);
  const reversed: RoomId[] = [];
  let cursor: RoomId | null = to;
  while (cursor) {
    reversed.push(cursor);
    cursor = previous.get(cursor) ?? null;
  }
  return reversed.reverse();
}

/**
 * Continuous world movement. Coordinates are world-space pixels; the player
 * walks freely across a room and through a connecting corridor (통로) into the
 * next room. Returns true when the player entered a different room so the
 * caller can trigger discovery.
 */
export function movePlayerWorld(
  player: Pick<SimulationPlayer, "roomId" | "x" | "y">,
  deltaX: number,
  deltaY: number,
  rooms: ReadonlyMap<CoreRoomId, CoreRoom>,
): boolean {
  if (player.roomId === BOSS_ROOM_ID) {
    const boss = bossWorldRect();
    player.x = clamp(player.x + deltaX, boss.x + ROOM_EDGE_INSET, boss.x + boss.width - ROOM_EDGE_INSET);
    player.y = clamp(player.y + deltaY, boss.y + ROOM_EDGE_INSET, boss.y + boss.height - ROOM_EDGE_INSET);
    return false;
  }

  // Restrict to the player's current zone so rooms from different zones (which
  // share the same grid coordinates) never overlap in world space.
  const current = rooms.get(player.roomId);
  const zone = current?.zone;
  const zoneRooms = zone ? [...rooms.values()].filter((room) => room.zone === zone) : [...rooms.values()];
  const world = buildWorldFromRooms(zoneRooms, zone === 3);
  const resolved = resolveWalkablePoint(world.rects, player.x + deltaX, player.y + deltaY, player.x, player.y);
  player.x = resolved.x;
  player.y = resolved.y;
  const containing = roomContainingPoint(world.grid, resolved.x, resolved.y);
  if (containing && containing !== player.roomId) {
    player.roomId = containing as CoreRoomId;
    return true;
  }
  return false;
}



/** Nearest alive enemy inside the player's room, range and cursor-facing cone. */
export function selectNearestConeEnemy(
  player: Pick<SimulationPlayer, "roomId" | "x" | "y" | "aim">,
  enemies: Iterable<CoreEnemy>,
  attackRange: number,
  coneHalfAngle: number,
): CoreEnemy | null {
  let selected: CoreEnemy | null = null;
  let selectedDistance = Number.POSITIVE_INFINITY;
  for (const enemy of enemies) {
    if (!enemy.alive || enemy.roomId !== player.roomId) continue;
    const dx = enemy.x - player.x;
    const dy = enemy.y - player.y;
    const distance = Math.hypot(dx, dy);
    if (distance > attackRange) continue;
    const angularError = Math.abs(wrapAngle(Math.atan2(dy, dx) - player.aim));
    if (angularError > coneHalfAngle) continue;
    if (distance < selectedDistance || (distance === selectedDistance && enemy.id.localeCompare(selected?.id ?? "") < 0)) {
      selected = enemy;
      selectedDistance = distance;
    }
  }
  return selected;
}

export function isPlayerOnWaypoint(player: SimulationPlayer, waypoint: CoreWaypoint): boolean {
  return player.roomId === waypoint.roomId && Math.hypot(player.x - waypoint.x, player.y - waypoint.y) <= WAYPOINT_RADIUS;
}

export function createEmptyEquipment(): CoreEquipmentLoadout {
  return { weapon: null, armor: null, accessory: null };
}

export function equipmentBonuses(loadout: CoreEquipmentLoadout): CoreEquipmentBonuses {
  const multiplier = (item: PersonalHiddenDrop | null) => item
    ? item.statMultiplier * (1 + (item.upgradeLevel ?? 0) * 0.2)
    : 0;
  const weaponMultiplier = multiplier(loadout.weapon);
  const armorMultiplier = multiplier(loadout.armor);
  const accessoryMultiplier = multiplier(loadout.accessory);
  return {
    attackBonus: Math.round(20 * weaponMultiplier),
    maxHpBonus: Math.round(80 * armorMultiplier),
    defenseBonus: Math.round(8 * armorMultiplier),
    attackSpeedBonus: Math.round(30 * accessoryMultiplier),
  };
}

export function equipmentPower(item: PersonalHiddenDrop | null): number {
  if (!item) return 0;
  const rarity = EQUIPMENT_RARITIES[item.rarity];
  return Math.round(rarity.statMultiplier * 100 * (1 + (item.upgradeLevel ?? 0) * 0.2) + rarity.specialOptionCount * 18);
}

export function augmentAttackBonus(stacks: AugmentStacks): number {
  return (stacks.power ?? 0) * 3;
}

export function makeDraftId(seed: string | number, playerId: string, level: number, draftIndex: number): string {
  return `draft:${level}:${hashSeed(`${seed}:${playerId}:${level}:${draftIndex}`).toString(16)}`;
}

export function waypointId(roomId: CoreRoomId, kind: CoreWaypointKind): string {
  return `waypoint:${roomId}:${kind}`;
}

export function doorId(left: CoreRoomId, right: CoreRoomId): string {
  return `door:${[left, right].sort().join("|")}`;
}

function createZoneWaypoints(zoneMap: ZoneMap, waypoints: Map<string, CoreWaypoint>): void {
  const start = zoneMap.rooms.find((room) => room.id === zoneMap.startRoomId);
  const central = zoneMap.rooms.find((room) => room.type === "central-waypoint");
  const gate = zoneMap.rooms.find((room) => room.id === zoneMap.gateRoomId);
  if (!start || !central || !gate) throw new Error(`Zone ${zoneMap.zone} is missing a waypoint room`);

  const startId = waypointId(start.id, "start");
  const centralId = waypointId(central.id, "central");
  const gateKind: CoreWaypointKind = zoneMap.zone === 3 ? "boss" : "gate";
  const gateId = waypointId(gate.id, gateKind);
  const nextStartId = zoneMap.zone < 3
    ? waypointId(`zone-${zoneMap.zone + 1}:0,4` as RoomId, "start")
    : BOSS_ROOM_ID;

  waypoints.set(startId, createWaypoint(startId, start.id, zoneMap.zone, "start", centralId, zoneMap.zone === 1));
  waypoints.set(centralId, createWaypoint(centralId, central.id, zoneMap.zone, "central", startId, false));
  waypoints.set(gateId, createWaypoint(gateId, gate.id, zoneMap.zone, gateKind, nextStartId, false));
}

function createWaypoint(
  id: string,
  roomId: RoomId,
  zone: ZoneId,
  kind: CoreWaypointKind,
  destinationId: string,
  active: boolean,
): CoreWaypoint {
  const grid = roomIdToGrid(roomId) ?? { x: 0, y: 0 };
  const center = roomWorldCenter(grid);
  return {
    id,
    roomId,
    zone,
    kind,
    x: center.x,
    y: center.y,
    destinationId,
    active,
    requiredPlayers: 0,
    holdingPlayers: 0,
    holdProgress: 0,
    holdDurationMs: (kind === "gate" || kind === "boss" ? WAYPOINT_HOLD_SECONDS : FAST_TRAVEL_HOLD_SECONDS) * 1_000,
  };
}

export function createSeededRoomEnemy(
  seed: string | number,
  roomId: CoreRoomId,
  zone: ZoneId,
  kind: "static" | "hidden" | "gate",
  difficulty: "easy" | "normal" | "hard",
  originX: number,
  originY: number,
  roomWidth = ROOM_WIDTH,
  roomHeight = ROOM_HEIGHT,
): CoreEnemy {
  const random = createSeededRandom(`enemy:${seed}:${roomId}:${kind}`);
  const base = ENEMY_RULES[kind];
  const difficultyRule = DIFFICULTY_MULTIPLIER[difficulty];
  const zoneScale = 1 + (zone - 1) * 0.28;
  const hp = Math.round(base.hp * zoneScale * difficultyRule.hp);
  const x = originX + (kind === "gate" ? roomWidth * 0.76 : roomWidth * (0.35 + random.next() * 0.3));
  const y = originY + (kind === "gate" ? roomHeight * 0.24 : roomHeight * (0.3 + random.next() * 0.4));
  return {
    id: `enemy:${kind}:${roomId}:${hashSeed(`${seed}:${roomId}`).toString(16)}`,
    kind,
    behavior: kind === "gate" ? "gate" : "static",
    roomId,
    spawnRoomId: roomId,
    x,
    y,
    spawnX: x,
    spawnY: y,
    hp,
    maxHp: hp,
    damage: Math.round(base.damage * zoneScale * difficultyRule.damage),
    speed: base.speed,
    attackRange: base.attackRange,
    attackCooldown: 0,
    xpReward: Math.round(base.xp * zoneScale),
    goldReward: Math.round(base.gold * zoneScale),
    alive: true,
    aggroed: false,
    targetId: null,
    lastHitBy: null,
    path: [],
    pathIndex: 0,
    coarseProgress: 0,
    respawnRemaining: null,
    patternKind: "fan",
    patternPhase: "idle",
    patternRemaining: 0,
    patternIndex: 0,
    attackSequence: 0,
    transformRevision: 0,
    lastMoveSpeed: 0,
  };
}

export type EnemyPatternTier = "hidden" | "gate" | "boss";

export function enemyPatternConfig(tier: EnemyPatternTier): Readonly<{
  rayCount: number;
  range: number;
  floorCount: number;
  floorRadius: number;
  telegraphSeconds: number;
  cooldownSeconds: number;
}> {
  if (tier === "hidden") return { rayCount: 8, range: 420, floorCount: 5, floorRadius: 54, telegraphSeconds: 1.05, cooldownSeconds: 1.55 };
  if (tier === "boss") return { rayCount: 16, range: 660, floorCount: 10, floorRadius: 74, telegraphSeconds: 0.65, cooldownSeconds: 0.65 };
  return { rayCount: 12, range: 520, floorCount: 7, floorRadius: 64, telegraphSeconds: 0.85, cooldownSeconds: 1 };
}

export function enemyFanPatternAngles(patternIndex: number, tier: EnemyPatternTier = "gate"): readonly number[] {
  const config = enemyPatternConfig(tier);
  const rotation = patternIndex * Math.PI / (config.rayCount * 2);
  return Array.from({ length: config.rayCount }, (_, index) => rotation + index * Math.PI * 2 / config.rayCount);
}

export function enemyFloorPatternCircles(x: number, y: number, patternIndex: number, tier: EnemyPatternTier = "gate"): readonly { x: number; y: number; radius: number }[] {
  const config = enemyPatternConfig(tier);
  const rotation = patternIndex * Math.PI / config.floorCount;
  return Array.from({ length: config.floorCount }, (_, index) => {
    const angle = rotation + index * Math.PI * 2 / config.floorCount;
    const distance = index % 2 === 0 ? 155 : 265;
    return { x: x + Math.cos(angle) * distance, y: y + Math.sin(angle) * distance, radius: config.floorRadius };
  });
}

function enemyKindForRoom(type: RoomType): "static" | "hidden" | "gate" | null {
  if (type === "static-monster") return "static";
  if (type === "hidden-monster") return "hidden";
  if (type === "gate") return "gate";
  return null;
}

function wrapAngle(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
