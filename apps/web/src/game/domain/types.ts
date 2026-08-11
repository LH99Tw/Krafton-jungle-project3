import type { AugmentId } from "@five-days/game-core";
export type {
  FastLaneOffer,
  InputFrame,
  TransformSample,
  TransportMode,
  WorldFrame,
} from "@five-days/protocol";

export type HeroClassId = "swordsman" | "archer" | "mage";
export type SessionMode = "prototype" | "full";
export type PartyMode = "solo" | "coop";
export type Phase = "day" | "night" | "standby" | "boss" | "ended";
export type BuildMode = "turret" | "wall" | "upgrade" | null;
export type ResultState = "victory" | "defeat";

export type HeroStats = {
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

export type UpgradeDefinition = {
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
  goldSpent: number;
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
  roomId: string;
  x: number;
  y: number;
  aim: number;
  isLocal: boolean;
};

export type RoomMapCell = {
  id: string;
  zone: number;
  x: number;
  y: number;
  type: "start" | "gate" | "resource" | "static-monster" | "empty" | "central-waypoint" | "hidden-monster" | "boss";
  visited: boolean;
  current: boolean;
  cleared: boolean;
  connections: string[];
};

export type EquipmentSummary = {
  slot: "weapon" | "armor" | "accessory";
  name: string;
  rarity: "normal" | "rare" | "epic" | "legendary" | "mythic";
  power: number;
};

type WaypointSnapshot = {
  nearby: boolean;
  id: string | null;
  label: string;
  destinationLabel: string;
  destinationId: string;
  holdProgress: number;
  requiredPlayers: number;
  presentPlayers: number;
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
};

export type NetworkDropSnapshot = {
  id: string;
  ownerUserId: string;
  roomId: string;
  slot: EquipmentSummary["slot"];
  rarity: "legendary" | "mythic";
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
  gold: number;
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
    kind: "start" | "central" | "gate" | "boss";
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
  localEquipment: EquipmentSummary[];
  stats: TeamStats;
};

export type GameSnapshot = {
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
  gold: number;
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
  equipment: EquipmentSummary[];
  buildSupported: boolean;
  inBuildZone: boolean;
  waypoint: WaypointSnapshot;
};

export type GameStartOptions = {
  heroClass: HeroClassId;
  sessionMode: SessionMode;
  difficulty: "easy" | "normal" | "hard";
  partyMode: PartyMode;
  networked?: boolean;
  userId?: string;
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
  gold: 0,
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
    goldSpent: 0,
    gatesDestroyed: 0,
  },
  party: [],
  currentZone: 1,
  currentRoomId: "zone-1:0,4",
  roomsExplored: 1,
  roomMap: [],
  equipment: [],
  buildSupported: false,
  inBuildZone: true,
  waypoint: {
    nearby: true,
    id: "zone-1:0,4-waypoint",
    label: "베이스 웨이포인트",
    destinationLabel: "현재 구역",
    destinationId: "",
    holdProgress: 0,
    requiredPlayers: 1,
    presentPlayers: 1,
  },
};
