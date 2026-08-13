import { BASE_CRITICAL_CHANCE, type AugmentId } from "@five-days/game-core";
import type { MiniMapGeometry } from "@five-days/protocol";
import type { EditorMapDefinition } from "./mapEditor";
export type HeroClassId = "swordsman" | "archer" | "mage";
type SessionMode = "prototype" | "full";
type PartyMode = "solo" | "coop";
export type Phase = "day" | "night" | "boss" | "ended";
export type BuildMode = "turret" | "wall" | "upgrade" | null;
type ResultState = "victory" | "defeat";

type HeroStats = {
  maxHp: number;
  hp: number;
  attack: number;
  defense: number;
  moveSpeed: number;
  attackIntervalMs: number;
  attackRange: number;
  skillPower: number;
  projectileCount: number;
};

export type ClassDefinition = {
  id: HeroClassId;
  name: string;
  epithet: string;
  description: string;
  color: number;
  cssColor: string;
  accentColor: string;
  role: string;
  attackKind: "melee" | "projectile" | "magic";
  stats: Omit<HeroStats, "hp">;
  skills: [
    { key: "Q"; name: string; description: string; cooldownMs: number },
    { key: "E"; name: string; description: string; cooldownMs: number },
  ];
};

export type UpgradeId = AugmentId;

type UpgradeDefinition = {
  id: UpgradeId;
  name: string;
  description: string;
  tag: "공용" | "검사" | "궁수" | "마법사" | "전직";
  classId?: HeroClassId;
  maxStacks: number;
  rarity: "normal" | "rare" | "epic";
};

export type UpgradeChoice = UpgradeDefinition & {
  stack: number;
};

export type TeamStats = {
  damage: number;
  bossDamage: number;
  kills: number;
  deaths: number;
  structuresBuilt: number;
  gatesDestroyed: number;
};

export type PartyMemberSnapshot = {
  userId: string;
  displayName: string;
  heroClass: HeroClassId;
  hp: number;
  maxHp: number;
  level: number;
  teamPower: number;
  ready: boolean;
  connected: boolean;
  alive: boolean;
  respawnRemaining?: number;
  roomId: string;
  x: number;
  y: number;
  aim: number;
  attackSequence: number;
  attackTargetId: string;
  attackCritical: boolean;
  isLocal: boolean;
  equipment: EquipmentSummary[];
  qCooldown?: number;
  eCooldown?: number;
  dashCooldown?: number;
  skillSequence?: number;
  lastSkillId?: "q" | "e" | "dash" | "";
  skillOriginX?: number;
  skillOriginY?: number;
  skillTargetX?: number;
  skillTargetY?: number;
  skillRadius?: number;
  combatStats?: PlayerCombatStats;
  inventory?: Array<{ id: string; slot: EquipmentSummary["slot"]; rarity: EquipmentSummary["rarity"] } | null>;
  respawnRoomId?: string;
  altarAttempts?: number;
  shrineBuff?: string;
  shrineBuffRemaining?: number;
};

export type PlayerCombatStats = {
  attackDamage: number;
  defense: number;
  criticalChance: number;
  criticalDamage: number;
  attacksPerSecond: number;
  attackRange: number;
  moveSpeed: number;
};

export type RoomMapCell = {
  id: string;
  zone: number;
  x: number;
  y: number;
  type: "start" | "gate" | "resource" | "static-monster" | "empty" | "central-waypoint" | "hidden-monster" | "boss"
    | "gate-candidate" | "shrine" | "trap" | "checkpoint" | "altar";
  visited: boolean;
  current: boolean;
  cleared: boolean;
  connections: string[];
};

export type MiniMapSnapshot = {
  geometry: MiniMapGeometry;
  explorationMask: Uint8Array;
  revision: number;
};

export type EquipmentSummary = {
  slot: "weapon" | "armor" | "accessory";
  name: string;
  rarity: "normal" | "rare" | "epic" | "legendary" | "mythic";
  power: number;
};

export type WaypointSnapshot = {
  nearby: boolean;
  id: string | null;
  destinationId: string;
  holdProgress: number;
};

export type NetworkEnemySnapshot = {
  id: string;
  kind: string;
  behavior: "static" | "invader" | "hidden" | "gate" | "boss";
  roomId: string;
  spawnRoomId: string;
  targetId: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  patternKind: "fan" | "floor";
  patternPhase: "idle" | "telegraph";
  patternRemaining: number;
  patternIndex: number;
  attackSequence: number;
};

export type NetworkDropSnapshot = {
  id: string;
  ownerUserId: string;
  roomId: string;
  slot: EquipmentSummary["slot"];
  rarity: EquipmentSummary["rarity"];
  x: number;
  y: number;
  specialOptionCount: number;
};

export type NetworkWorldSnapshot = {
  matchId: string;
  seed: string;
  phase: "lobby" | Phase;
  resultState: "victory" | "defeat" | "abandoned" | null;
  resultReason: string;
  day: number;
  serverTime: number;
  elapsed: number;
  phaseEndsAt: number;
  baseHp: number;
  baseMaxHp: number;
  currentZone: number;
  teamLevel: number;
  teamXp: number;
  teamXpToNext: number;
  players: PartyMemberSnapshot[];
  rooms: RoomMapCell[];
  enemies: NetworkEnemySnapshot[];
  drops: NetworkDropSnapshot[];
  waypoints: Array<{
    id: string;
    roomId: string;
    kind: "start" | "central" | "checkpoint" | "gate" | "boss";
    destinationId: string;
    active: boolean;
    requiredPlayers: number;
    holdingPlayers: number;
    holdProgress: number;
    holdDurationMs: number;
  }>;
  waypointHoldProgress: number;
  localUpgradeDraft: {
    draftId: string;
    level: number;
    choices: UpgradeChoice[];
  } | null;
  stats: TeamStats;
  minimap: MiniMapSnapshot | null;
  specialRooms: Array<{ roomId: string; kind: string; shrineKind: string; shrineClaimedBy: string; shrineClaimingBy: string; shrineClaimProgress: number; trapPhase: string; trapDebuff: string; trapParticipants: string[] }>;
};

export type GameSnapshot = {
  worldMode: "editor" | "official";
  running: boolean;
  phase: Phase;
  phaseLabel: string;
  day: number;
  phaseRemaining: number;
  elapsed: number;
  hp: number;
  maxHp: number;
  baseHp: number;
  baseMaxHp: number;
  level: number;
  xp: number;
  xpToNext: number;
  teamPower: number;
  gatesDestroyed: number;
  buildMode: BuildMode;
  qCooldown: number;
  eCooldown: number;
  dashCooldown: number;
  bossAvailable: boolean;
  bossHp: number | null;
  bossMaxHp: number | null;
  message: string;
  upgrades: Array<{ name: string; stack: number }>;
  stats: TeamStats;
  party: PartyMemberSnapshot[];
  currentZone: number;
  currentRoomId: string;
  roomsExplored: number;
  roomMap: RoomMapCell[];
  minimap: MiniMapSnapshot | null;
  explorationPercent: number;
  equipment: EquipmentSummary[];
  combatStats: PlayerCombatStats;
  buildSupported: boolean;
  inBuildZone: boolean;
  waypoint: WaypointSnapshot;
  specialRoom?: {
    kind: string;
    state: NetworkWorldSnapshot["specialRooms"][number] | null;
    inventory: NonNullable<PartyMemberSnapshot["inventory"]>;
    respawnRoomId: string;
    altarAttempts: number;
    shrineBuff: string;
    shrineBuffRemaining: number;
  } | null;
};

export type GameStartOptions = {
  heroClass: HeroClassId;
  sessionMode: SessionMode;
  difficulty: "normal" | "hard";
  partyMode: PartyMode;
  runtimeMode?: "server" | "editor-core";
  userId?: string;
  editorMap?: EditorMapDefinition;
};

export type GameResult = {
  state: ResultState;
  reason: string;
  elapsed: number;
  day: number;
  level: number;
  teamPower: number;
  stats: TeamStats;
};

export const EMPTY_SNAPSHOT: GameSnapshot = {
  worldMode: "official",
  running: false,
  phase: "day",
  phaseLabel: "낮",
  day: 1,
  phaseRemaining: 0,
  elapsed: 0,
  hp: 0,
  maxHp: 0,
  baseHp: 0,
  baseMaxHp: 0,
  level: 1,
  xp: 0,
  xpToNext: 20,
  teamPower: 0,
  gatesDestroyed: 0,
  buildMode: null,
  qCooldown: 0,
  eCooldown: 0,
  dashCooldown: 0,
  bossAvailable: false,
  bossHp: null,
  bossMaxHp: null,
  message: "원정 준비 중",
  upgrades: [],
  stats: {
    damage: 0,
    bossDamage: 0,
    kills: 0,
    deaths: 0,
    structuresBuilt: 0,
    gatesDestroyed: 0,
  },
  party: [],
  currentZone: 1,
  currentRoomId: "zone-1:0,4",
  roomsExplored: 1,
  roomMap: [],
  minimap: null,
  explorationPercent: 0,
  equipment: [],
  combatStats: {
    attackDamage: 0,
    defense: 0,
    criticalChance: BASE_CRITICAL_CHANCE * 100,
    criticalDamage: 150,
    attacksPerSecond: 0,
    attackRange: 0,
    moveSpeed: 0,
  },
  buildSupported: false,
  inBuildZone: true,
  waypoint: {
    nearby: true,
    id: "zone-1:0,4-waypoint",
    destinationId: "",
    holdProgress: 0,
  },
};
