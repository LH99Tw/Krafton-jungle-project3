import type { HeroClassId } from "@five-days/protocol";
import type { PersonalHiddenDrop } from "../v02/equipment";
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
export type CoreNotice = Readonly<{
  userId: string | null;
  code: "ZONE_GATE_LOCKED" | "GATE_DESTROYED";
  message: string;
}>;

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
  respawnRemaining: number;
  ready: boolean;
  connected: boolean;
  lastSeq: number;
  lastInputAt: number;
  lastButtons: number;
  inputX: number;
  inputY: number;
  equipment: CoreEquipmentLoadout;
  inventory: Array<PersonalHiddenDrop | null>;
  respawnRoomId: CoreRoomId;
  altarAttempts: number;
  altarMultipliers: CoreAltarMultipliers;
  shrineBuff: CoreShrineBuff | null;
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
  skillOriginX: number;
  skillOriginY: number;
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
  gatesDestroyed: number;
  /** Assigned to AI-controlled party members so the server can drive them. */
  aiRole?: "follower" | "defender";
};

export type CoreAltarStat = "attack" | "attackSpeed" | "maxHp" | "moveSpeed" | "skillPower";
export type CoreAltarMultipliers = Record<CoreAltarStat, number>;
export type CoreShrineKind = "berserker" | "assassin" | "giant" | "wind" | "infinity" | "doom";
export type CoreShrineBuff = Readonly<{ kind: CoreShrineKind; expiresAt: number }>;

export type CoreSpecialRoomState = {
  roomId: CoreRoomId;
  kind: "shrine" | "trap" | "checkpoint" | "altar";
  shrineKind?: CoreShrineKind;
  shrineClaimedBy?: string;
  shrineClaimingBy?: string;
  shrineClaimProgress?: number;
  trapPhase?: "idle" | "warning" | "wave" | "hidden" | "cleared";
  trapDebuff?: string;
  trapParticipants?: string[];
  trapProgress?: number;
};

export type GameCoreOptions = {
  mode: "prototype" | "full";
  difficulty: "normal" | "hard";
  /** Frozen encounter scaling size, including AI party members. */
  balancePartySize?: 1 | 2 | 3;
  seed: string;
  minimumPlayers?: number;
  /** Per-room circuit breaker for simultaneously active gate invaders. */
  maxLiveInvaders?: number;
  /** Optional local-authored world. Omitted for the production procedural world. */
  world?: CoreWorldDefinition;
  /** Optional server-side LOD. The authoritative clock and combat remain 60Hz. */
  invaderUpdateRates?: Readonly<{
    warmHz: number;
    coldHz: number;
    warmMovementHz?: number;
    coldMovementHz?: number;
  }>;
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
  specialRooms: readonly CoreSpecialRoomState[];
}>;

export type InvaderNavigation = {
  targetPreference: "base" | "player";
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
  lastUpdateAt: number;
  nextDecisionTick: number;
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
