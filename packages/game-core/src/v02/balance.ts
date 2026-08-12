import type { Difficulty } from "@five-days/protocol";

export type BalancePartySize = 1 | 2 | 3;

export const DIFFICULTY_RULES: Readonly<Record<Difficulty, Readonly<{ hp: number; damage: number }>>> = {
  normal: { hp: 1.35, damage: 1.15 },
  hard: { hp: 1.8, damage: 1.45 },
};

export const ZONE_CLEAR_XP = { 1: 318, 2: 631, 3: 901 } as const;

export const ZONE_ONE_ENEMY_MULTIPLIERS = {
  static: { hp: 0.8, damage: 0.75 },
  gate: { hp: 0.9, damage: 0.9 },
} as const;

export const ZONE_ONE_STATIC_XP = 12;

export const INVADER_BALANCE = {
  hp: 0.85,
  damage: 0.85,
  xpRatioToStatic: 0.2,
} as const;

export function staticMonsterXp(zone: 1 | 2 | 3): number {
  if (zone === 1) return ZONE_ONE_STATIC_XP;
  return Math.round(18 * (1 + (zone - 1) * 0.28));
}

export function invaderXp(zone: 1 | 2 | 3): number {
  return Math.max(1, Math.round(staticMonsterXp(zone) * INVADER_BALANCE.xpRatioToStatic));
}

export const EQUIPMENT_BALANCE = {
  attack: 10,
  maxHp: 60,
  defensePercent: 12,
  attackSpeedPercent: 20,
  maxDefensePercent: 30,
} as const;

export const SPECIAL_ROOM_BALANCE = {
  altarIncrease: 1.2,
  altarDecrease: 0.8,
  altarMinimum: 0.6,
  altarMaximum: 1.6,
  shrineAttack: { berserker: 1.35, giant: 1.25, doom: 1.5 },
  shrineAttackSpeed: 0.25,
  shrineCriticalChance: { assassin: 0.35, doom: 0.5 },
  shrineCriticalDamage: 0.25,
  shrineMoveSpeed: 1.5,
  shrineCooldownReduction: 0.35,
  shrineArea: 1.5,
} as const;

export const BOSS_THREE_PLAYER_HP: Readonly<Record<Difficulty, number>> = {
  normal: 10_000,
  hard: 15_000,
};

export function partyHpMultiplier(partySize: BalancePartySize): number {
  return 1 + (partySize - 1) * 0.65;
}

export function waveTotal(phase: "day" | "night", difficulty: Difficulty): number {
  if (phase === "day") return difficulty === "hard" ? 45 : 36;
  return difficulty === "hard" ? 204 : 168;
}

export function waveBatchSize(phase: "day" | "night", difficulty: Difficulty, waveIndex: number, waveCount: number): number {
  const total = waveTotal(phase, difficulty);
  const before = Math.floor(total * waveIndex / waveCount);
  const after = Math.floor(total * (waveIndex + 1) / waveCount);
  return Math.max(0, after - before);
}
