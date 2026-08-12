import type { HeroClassId } from "@five-days/protocol";
import { createSeededRandom } from "./random";

export const MAX_LEVEL = 30;
export const MILESTONE_LEVELS = [10, 20, 30] as const;
export const LEVEL_XP_BASE = 14;
export const LEVEL_XP_PER_LEVEL = 9;
export const LEVEL_XP_ROUNDING_UNIT = 10;

export type AugmentRarity = "normal" | "rare" | "epic";
export type AugmentPool = "general" | "milestone";

/** High-rarity level-up choices are intentionally less frequent. */
export const AUGMENT_RARITY_WEIGHTS: Readonly<Record<AugmentRarity, number>> = {
  normal: 1,
  rare: 0.5,
  epic: 0.25,
};

export type AugmentId =
  | "power"
  | "haste"
  | "multishot"
  | "skill-power"
  | "precision"
  | "ferocity"
  | "boss-hunter"
  | "skill-haste"
  | "area-power"
  | "momentum"
  | "swordsman-blade"
  | "swordsman-execution"
  | "swordsman-whirlwind"
  | "swordsman-combo"
  | "swordsman-rupture"
  | "archer-volley"
  | "archer-sniper"
  | "archer-piercing"
  | "archer-ricochet"
  | "archer-mark"
  | "mage-nova"
  | "mage-tempo"
  | "mage-chain"
  | "mage-overcharge"
  | "mage-echo";

export type AugmentEffect = Readonly<{
  kind: string;
  values: Readonly<Record<string, number>>;
}>;

export type AugmentDefinition = Readonly<{
  id: AugmentId;
  name: string;
  description: string;
  pool: AugmentPool;
  rarity: AugmentRarity;
  maxStacks: number;
  classId?: HeroClassId;
  effect: AugmentEffect;
}>;

/**
 * General pool capacity is 37 stacks across ten attack-only definitions.
 * There are 26 non-milestone choices from levels 2-30. Even after any 25
 * legal selections, at least three definitions remain draftable.
 */
export const GENERAL_AUGMENTS: readonly AugmentDefinition[] = [
  {
    id: "power",
    name: "무모한 연마",
    description: "공격력 +1.5",
    pool: "general",
    rarity: "normal",
    maxStacks: 4,
    effect: { kind: "attack-flat", values: { amount: 1.5 } },
  },
  {
    id: "haste",
    name: "신속의 문장",
    description: "자동 공격 속도 +4%",
    pool: "general",
    rarity: "normal",
    maxStacks: 4,
    effect: { kind: "attack-speed-percent", values: { percent: 4 } },
  },
  {
    id: "multishot",
    name: "쌍둥이 별",
    description: "원거리는 투사체 +1, 근접은 공격 범위 +10%",
    pool: "general",
    rarity: "epic",
    maxStacks: 2,
    effect: { kind: "class-adaptive-multishot", values: { projectileCount: 1, meleeRangePercent: 10 } },
  },
  {
    id: "skill-power",
    name: "불안정한 마력",
    description: "스킬 위력 +9%",
    pool: "general",
    rarity: "rare",
    maxStacks: 3,
    effect: { kind: "skill-power-percent", values: { percent: 9 } },
  },
  {
    id: "precision",
    name: "매의 눈",
    description: "치명타 확률 +2%p",
    pool: "general",
    rarity: "normal",
    maxStacks: 4,
    effect: { kind: "critical-chance-points", values: { points: 2 } },
  },
  {
    id: "ferocity",
    name: "잔혹한 예리함",
    description: "치명타 피해 +8%",
    pool: "general",
    rarity: "rare",
    maxStacks: 4,
    effect: { kind: "critical-damage-percent", values: { percent: 8 } },
  },
  {
    id: "boss-hunter",
    name: "거물 사냥꾼",
    description: "엘리트·게이트·보스 피해 +4%",
    pool: "general",
    rarity: "rare",
    maxStacks: 4,
    effect: { kind: "major-target-damage-percent", values: { percent: 4 } },
  },
  {
    id: "skill-haste",
    name: "가속 각인",
    description: "스킬 재사용 대기시간 -2%",
    pool: "general",
    rarity: "rare",
    maxStacks: 4,
    effect: { kind: "skill-cooldown-reduction-percent", values: { percent: 2 } },
  },
  {
    id: "area-power",
    name: "확산하는 힘",
    description: "공격 및 스킬 범위 +5%",
    pool: "general",
    rarity: "rare",
    maxStacks: 4,
    effect: { kind: "attack-area-percent", values: { percent: 5 } },
  },
  {
    id: "momentum",
    name: "끊임없는 공세",
    description: "같은 대상을 연속 타격할 때 타격당 피해 +1.5%, 최대 +6%",
    pool: "general",
    rarity: "rare",
    maxStacks: 4,
    effect: { kind: "consecutive-hit-damage", values: { percentPerHit: 1.5, maxPercent: 6 } },
  },
] as const;

export const MILESTONE_AUGMENTS: readonly AugmentDefinition[] = [
  {
    id: "swordsman-blade",
    name: "검기 개방",
    description: "검격이 사거리 240의 검기를 발사합니다.",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "swordsman",
    effect: { kind: "blade-projectile", values: { range: 240, damagePercent: 50 } },
  },
  {
    id: "swordsman-execution",
    name: "처형자",
    description: "체력 30% 이하 적에게 주는 피해 +30%",
    pool: "milestone",
    rarity: "rare",
    maxStacks: 1,
    classId: "swordsman",
    effect: { kind: "execute-damage", values: { hpThresholdPercent: 30, damagePercent: 30 } },
  },
  {
    id: "swordsman-whirlwind",
    name: "회오리 검무",
    description: "근접 자동 공격의 부채꼴 각도 +22.5%",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "swordsman",
    effect: { kind: "melee-arc-percent", values: { percent: 22.5 } },
  },
  {
    id: "swordsman-combo",
    name: "삼연참",
    description: "세 번째 자동 공격이 +50% 피해를 줍니다.",
    pool: "milestone",
    rarity: "rare",
    maxStacks: 1,
    classId: "swordsman",
    effect: { kind: "nth-attack-damage", values: { attackNumber: 3, damagePercent: 50 } },
  },
  {
    id: "swordsman-rupture",
    name: "갑주 파쇄",
    description: "스킬 적중 시 3초간 대상이 받는 피해 +7.5%",
    pool: "milestone",
    rarity: "rare",
    maxStacks: 1,
    classId: "swordsman",
    effect: { kind: "vulnerability-on-skill", values: { durationMs: 3_000, damagePercent: 7.5 } },
  },
  {
    id: "archer-volley",
    name: "탄막 사수",
    description: "자동 공격이 부채꼴 추가 화살 1발을 발사합니다.",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "archer",
    effect: { kind: "fan-projectile", values: { additionalProjectiles: 1, spreadRadians: 0.14 } },
  },
  {
    id: "archer-sniper",
    name: "명사수",
    description: "거리에 따라 피해가 증가해 최대 +27.5%가 됩니다.",
    pool: "milestone",
    rarity: "rare",
    maxStacks: 1,
    classId: "archer",
    effect: { kind: "distance-damage", values: { startDistance: 180, maxDistance: 460, maxPercent: 27.5 } },
  },
  {
    id: "archer-piercing",
    name: "관통 화살촉",
    description: "자동 공격 투사체 관통 +2",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "archer",
    effect: { kind: "projectile-pierce", values: { count: 2 } },
  },
  {
    id: "archer-ricochet",
    name: "되튐 사격",
    description: "첫 적중 후 다른 적 1명에게 32.5% 피해로 도탄합니다.",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "archer",
    effect: { kind: "projectile-ricochet", values: { targets: 1, damagePercent: 32.5 } },
  },
  {
    id: "archer-mark",
    name: "사냥감 표식",
    description: "스킬 적중 시 5초간 자동 공격 피해 +12.5% 표식을 남깁니다.",
    pool: "milestone",
    rarity: "rare",
    maxStacks: 1,
    classId: "archer",
    effect: { kind: "mark-on-skill", values: { durationMs: 5_000, autoAttackDamagePercent: 12.5 } },
  },
  {
    id: "mage-nova",
    name: "파괴술사",
    description: "마력탄과 룬의 폭발 범위 +27.5%",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "mage",
    effect: { kind: "magic-area-percent", values: { percent: 27.5 } },
  },
  {
    id: "mage-tempo",
    name: "시공술사",
    description: "스킬 재사용 대기시간 -12.5%",
    pool: "milestone",
    rarity: "rare",
    maxStacks: 1,
    classId: "mage",
    effect: { kind: "skill-cooldown-reduction-percent", values: { percent: 12.5 } },
  },
  {
    id: "mage-chain",
    name: "연쇄 붕괴",
    description: "폭발이 다른 적 1명에게 30% 피해로 연쇄됩니다.",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "mage",
    effect: { kind: "magic-chain", values: { targets: 1, damagePercent: 30 } },
  },
  {
    id: "mage-overcharge",
    name: "과충전",
    description: "네 번째 자동 공격이 +60% 피해를 줍니다.",
    pool: "milestone",
    rarity: "rare",
    maxStacks: 1,
    classId: "mage",
    effect: { kind: "nth-attack-damage", values: { attackNumber: 4, damagePercent: 60 } },
  },
  {
    id: "mage-echo",
    name: "주문 메아리",
    description: "Q/E 스킬이 0.35초 뒤 27.5% 위력으로 한 번 반복됩니다.",
    pool: "milestone",
    rarity: "rare",
    maxStacks: 1,
    classId: "mage",
    effect: { kind: "skill-echo", values: { delayMs: 350, damagePercent: 27.5 } },
  },
] as const;

export const AUGMENT_DEFINITIONS: readonly AugmentDefinition[] = [
  ...GENERAL_AUGMENTS,
  ...MILESTONE_AUGMENTS,
];

export const AUGMENT_BY_ID: ReadonlyMap<AugmentId, AugmentDefinition> = new Map(
  AUGMENT_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export type AugmentStacks = Readonly<Partial<Record<AugmentId, number>>>;

export type AugmentDraftInput = Readonly<{
  runSeed: string | number;
  playerId: string;
  heroClass: HeroClassId;
  level: number;
  stacks: AugmentStacks;
  draftIndex?: number;
}>;

export type LevelProgress = Readonly<{ level: number; xp: number }>;
export type ExperienceResult = Readonly<{
  progress: LevelProgress;
  gainedLevels: readonly number[];
  discardedXp: number;
}>;

export function isMilestoneLevel(level: number): level is (typeof MILESTONE_LEVELS)[number] {
  return MILESTONE_LEVELS.includes(level as (typeof MILESTONE_LEVELS)[number]);
}

/** XP required to move from `level` to `level + 1`; null at the cap. */
export function xpRequiredForNextLevel(level: number): number | null {
  assertLevel(level);
  return level >= MAX_LEVEL
    ? null
    : Math.round((LEVEL_XP_BASE + level * LEVEL_XP_PER_LEVEL) / LEVEL_XP_ROUNDING_UNIT) * LEVEL_XP_ROUNDING_UNIT;
}

export function addExperience(progress: LevelProgress, amount: number): ExperienceResult {
  assertLevel(progress.level);
  if (!Number.isInteger(progress.xp) || progress.xp < 0) throw new RangeError("xp must be a non-negative integer");
  if (!Number.isInteger(amount) || amount < 0) throw new RangeError("amount must be a non-negative integer");

  if (progress.level === MAX_LEVEL) {
    return { progress: { level: MAX_LEVEL, xp: 0 }, gainedLevels: [], discardedXp: progress.xp + amount };
  }

  let level = progress.level;
  let xp = progress.xp + amount;
  const gainedLevels: number[] = [];
  while (level < MAX_LEVEL) {
    const required = xpRequiredForNextLevel(level) as number;
    if (xp < required) break;
    xp -= required;
    level += 1;
    gainedLevels.push(level);
  }

  const discardedXp = level === MAX_LEVEL ? xp : 0;
  if (level === MAX_LEVEL) xp = 0;
  return { progress: { level, xp }, gainedLevels, discardedXp };
}

/** Creates exactly three deterministic, unique, legal choices. */
export function createAugmentDraft(input: AugmentDraftInput): readonly AugmentDefinition[] {
  if (!Number.isInteger(input.level) || input.level < 2 || input.level > MAX_LEVEL) {
    throw new RangeError(`draft level must be between 2 and ${MAX_LEVEL}`);
  }
  if (input.playerId.length === 0) throw new RangeError("playerId must not be empty");

  const milestone = isMilestoneLevel(input.level);
  const pool = (milestone ? MILESTONE_AUGMENTS : GENERAL_AUGMENTS).filter((definition) => {
    if (milestone && definition.classId !== input.heroClass) return false;
    return stackOf(input.stacks, definition.id) < definition.maxStacks;
  });
  if (pool.length < 3) {
    throw new Error(`Insufficient legal augments for ${input.heroClass} at level ${input.level}: ${pool.length}`);
  }

  const stackSignature = Object.entries(input.stacks)
    .filter((entry): entry is [AugmentId, number] => typeof entry[1] === "number" && entry[1] > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, stack]) => `${id}:${stack}`)
    .join(",");
  const random = createSeededRandom(
    [input.runSeed, input.playerId, input.heroClass, input.level, input.draftIndex ?? 0, stackSignature].join(":"),
  );
  const choices: AugmentDefinition[] = [];
  const remaining = [...pool];
  while (choices.length < 3) {
    const totalWeight = remaining.reduce((sum, definition) => sum + AUGMENT_RARITY_WEIGHTS[definition.rarity], 0);
    let roll = random.next() * totalWeight;
    const selectedIndex = remaining.findIndex((definition) => {
      roll -= AUGMENT_RARITY_WEIGHTS[definition.rarity];
      return roll < 0;
    });
    const index = selectedIndex >= 0 ? selectedIndex : remaining.length - 1;
    choices.push(remaining.splice(index, 1)[0] as AugmentDefinition);
  }
  return choices;
}

export function addAugmentStack(stacks: AugmentStacks, id: AugmentId): AugmentStacks {
  const definition = AUGMENT_BY_ID.get(id);
  if (!definition) throw new RangeError(`Unknown augment: ${id}`);
  const current = stackOf(stacks, id);
  if (current >= definition.maxStacks) throw new RangeError(`${id} is already at max stacks`);
  return { ...stacks, [id]: current + 1 };
}

/** Reads a numeric effect from the canonical augment definition and applies its stack count. */
export function augmentEffectValue(
  stacks: AugmentStacks,
  id: AugmentId,
  key: string,
): number {
  const definition = AUGMENT_BY_ID.get(id);
  return (definition?.effect.values[key] ?? 0) * stackOf(stacks, id);
}

function stackOf(stacks: AugmentStacks, id: AugmentId): number {
  const value = stacks[id] ?? 0;
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`Invalid stack count for ${id}`);
  return value;
}

function assertLevel(level: number): void {
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
    throw new RangeError(`level must be between 1 and ${MAX_LEVEL}`);
  }
}
