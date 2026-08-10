export type HeroClassId = "swordsman" | "archer" | "mage";
export type SessionMode = "prototype" | "full";
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

export type UpgradeId =
  | "power"
  | "haste"
  | "vitality"
  | "armor"
  | "mobility"
  | "multishot"
  | "skill-power"
  | "base-link"
  | "swordsman-blade"
  | "swordsman-execution"
  | "archer-volley"
  | "archer-sniper"
  | "mage-nova"
  | "mage-tempo";

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
};

export type GameStartOptions = {
  heroClass: HeroClassId;
  sessionMode: SessionMode;
  difficulty: "easy" | "normal" | "hard";
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
};

