import type { HeroClassId } from "@five-days/protocol";
import type { ZoneId } from "../v02/map";
import type { AugmentStacks } from "../v02/progression";
import type {
  CoreDoor,
  CoreDrop,
  CoreEnemy,
  CoreEquipmentLoadout,
  CoreRoom,
  CoreRoomId,
  CoreUpgradeDraft,
  CoreWaypoint,
  CoreWorldDefinition,
} from "../v02/simulation";

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

export type InvaderNavigation = {
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

export type InvaderWaveBatch = {
  gateEnemyId: string;
  zone: ZoneId;
  remaining: number;
  queuedAt: number;
};

export type AiFollowNavigation = {
  targetX: number;
  targetY: number;
  path: readonly Readonly<{ x: number; y: number }>[];
  waypointIndex: number;
  replanAt: number;
};
