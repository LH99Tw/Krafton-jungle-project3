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
  rare: 0.2,
  epic: 0.04,
};

/** Player critical damage is fixed for every source (shrine, altar, augment). */
export const CRITICAL_DAMAGE_MULTIPLIER = 1.75;
/** Excess critical chance over 100% converts into attack power at this ratio. */
export const CRITICAL_OVERFLOW_TO_ATTACK = 0.5;

export type AugmentId =
  | "power"
  | "haste"
  | "skill-power"
  | "precision"
  | "boss-hunter"
  | "skill-haste"
  | "area-power"
  | "multishot"
  | "momentum"
  | "combat-rhythm"
  | "crit-loop"
  | "chain-explosion"
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
  /** Auto-generated from `effect.values`; kept optional so definitions stay canonical. */
  description?: string;
  pool: AugmentPool;
  rarity: AugmentRarity;
  maxStacks: number;
  classId?: HeroClassId;
  effect: AugmentEffect;
}>;

/**
 * General pool capacity is 37 stacks across twelve definitions
 * (4 Normal / 5 Rare / 3 Epic). There are 26 non-milestone choices from
 * levels 2-30. Range augments moved to Epic carry direct damage so choosing
 * them never causes a single-target DPS loss.
 */
export const GENERAL_AUGMENTS: readonly AugmentDefinition[] = [
  {
    id: "power",
    name: "공격 연마",
    pool: "general",
    rarity: "normal",
    maxStacks: 5,
    effect: { kind: "attack-flat", values: { amount: 2 } },
  },
  {
    id: "haste",
    name: "신속의 문장",
    pool: "general",
    rarity: "normal",
    maxStacks: 5,
    effect: { kind: "attack-speed-percent", values: { percent: 5 } },
  },
  {
    id: "skill-power",
    name: "불안정한 마력",
    pool: "general",
    rarity: "normal",
    maxStacks: 5,
    effect: { kind: "skill-power-percent", values: { percent: 10 } },
  },
  {
    id: "precision",
    name: "매의 눈",
    pool: "general",
    rarity: "normal",
    maxStacks: 5,
    effect: { kind: "critical-chance-points", values: { points: 8 } },
  },
  {
    id: "boss-hunter",
    name: "거물 사냥꾼",
    pool: "general",
    rarity: "rare",
    maxStacks: 2,
    effect: { kind: "major-target-damage-percent", values: { percent: 8 } },
  },
  {
    id: "skill-haste",
    name: "가속 각인",
    pool: "general",
    rarity: "rare",
    maxStacks: 2,
    effect: { kind: "skill-cooldown-reduction-percent", values: { percent: 6 } },
  },
  {
    id: "momentum",
    name: "끊임없는 공세",
    pool: "general",
    rarity: "rare",
    maxStacks: 2,
    effect: { kind: "consecutive-hit-damage", values: { percentPerHit: 2.5, maxPercent: 10 } },
  },
  {
    id: "combat-rhythm",
    name: "전투 리듬",
    pool: "general",
    rarity: "rare",
    maxStacks: 2,
    effect: { kind: "nth-attack-damage", values: { attackNumber: 4, damagePercent: 40 } },
  },
  {
    id: "crit-loop",
    name: "치명적 순환",
    pool: "general",
    rarity: "rare",
    maxStacks: 2,
    effect: { kind: "crit-loop", values: { points: 10, cooldownReduction: 0.15 } },
  },
  {
    id: "area-power",
    name: "확산하는 힘",
    pool: "general",
    rarity: "epic",
    maxStacks: 1,
    effect: { kind: "area-power", values: { allDamagePercent: 12, percent: 20 } },
  },
  {
    id: "multishot",
    name: "분열 공격",
    pool: "general",
    rarity: "epic",
    maxStacks: 1,
    effect: {
      kind: "split-attack",
      values: { damagePercent: 10, projectileCount: 1, meleeRangePercent: 15, projectileDamagePercent: 65 },
    },
  },
  {
    id: "chain-explosion",
    name: "파열 연쇄",
    pool: "general",
    rarity: "epic",
    maxStacks: 1,
    effect: { kind: "chain-explosion", values: { allDamagePercent: 8, radius: 120, damagePercent: 110 } },
  },
] as const;

export const MILESTONE_AUGMENTS: readonly AugmentDefinition[] = [
  {
    id: "swordsman-blade",
    name: "검기 개방",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "swordsman",
    effect: { kind: "blade-projectile", values: { damagePercent: 10, range: 260, baseRange: 180, falloffDamagePercent: 70 } },
  },
  {
    id: "swordsman-execution",
    name: "처형자",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "swordsman",
    effect: { kind: "execute-damage", values: { hpThresholdPercent: 25, damagePercent: 35 } },
  },
  {
    id: "swordsman-whirlwind",
    name: "회오리 검무",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "swordsman",
    effect: { kind: "melee-arc-percent", values: { damagePercent: 10, percent: 35 } },
  },
  {
    id: "swordsman-combo",
    name: "삼연참",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "swordsman",
    effect: { kind: "nth-attack-damage", values: { attackNumber: 3, damagePercent: 45 } },
  },
  {
    id: "swordsman-rupture",
    name: "갑주 파쇄",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "swordsman",
    effect: { kind: "vulnerability-on-skill", values: { durationMs: 4_000, damagePercent: 10 } },
  },
  {
    id: "archer-volley",
    name: "탄막 사수",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "archer",
    effect: { kind: "fan-projectile", values: { damagePercent: 10, additionalProjectiles: 1, projectileDamagePercent: 60 } },
  },
  {
    id: "archer-sniper",
    name: "명사수",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "archer",
    effect: { kind: "distance-damage", values: { startDistance: 200, maxDistance: 460, maxPercent: 22 } },
  },
  {
    id: "archer-piercing",
    name: "관통 화살촉",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "archer",
    effect: { kind: "projectile-pierce", values: { count: 2, damagePercent: 70, secondaryDamagePercent: 45 } },
  },
  {
    id: "archer-ricochet",
    name: "되튐 사격",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "archer",
    effect: { kind: "projectile-ricochet", values: { targets: 1, damagePercent: 45 } },
  },
  {
    id: "archer-mark",
    name: "사냥감 표식",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "archer",
    effect: { kind: "mark-on-skill", values: { durationMs: 5_000, autoAttackDamagePercent: 15 } },
  },
  {
    id: "mage-nova",
    name: "파괴술사",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "mage",
    effect: { kind: "magic-area-percent", values: { skillDamagePercent: 12, percent: 30 } },
  },
  {
    id: "mage-tempo",
    name: "시공술사",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "mage",
    effect: { kind: "skill-cooldown-reduction-percent", values: { percent: 15 } },
  },
  {
    id: "mage-chain",
    name: "연쇄 붕괴",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "mage",
    effect: { kind: "magic-chain", values: { targets: 1, damagePercent: 50 } },
  },
  {
    id: "mage-overcharge",
    name: "과충전",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "mage",
    effect: { kind: "nth-attack-damage", values: { attackNumber: 4, damagePercent: 60 } },
  },
  {
    id: "mage-echo",
    name: "주문 메아리",
    pool: "milestone",
    rarity: "epic",
    maxStacks: 1,
    classId: "mage",
    effect: { kind: "skill-echo", values: { delayMs: 350, damagePercent: 35 } },
  },
] as const;

/**
 * Generates the card description from the canonical effect definition so the
 * displayed text always matches the values used in combat. Each listed value
 * is the per-stack effect.
 */
export function describeAugment(definition: Pick<AugmentDefinition, "effect">): string {
  const v = definition.effect.values;
  switch (definition.effect.kind) {
    case "attack-flat":
      return `공격력 +${formatNum(v.amount ?? 0)}`;
    case "attack-speed-percent":
      return `자동 공격 속도 +${formatNum(v.percent ?? 0)}%`;
    case "skill-power-percent":
      return `스킬 피해 +${formatNum(v.percent ?? 0)}%`;
    case "critical-chance-points":
      return `치명타 확률 +${formatNum(v.points ?? 0)}%p`;
    case "major-target-damage-percent":
      return `엘리트·게이트·보스 피해 +${formatNum(v.percent ?? 0)}%`;
    case "skill-cooldown-reduction-percent":
      return `스킬 재사용 대기시간 -${formatNum(v.percent ?? 0)}%`;
    case "consecutive-hit-damage":
      return `연속 타격당 피해 +${formatNum(v.percentPerHit ?? 0)}%, 최대 +${formatNum(v.maxPercent ?? 0)}%`;
    case "nth-attack-damage":
      return `${ordinal(Number(v.attackNumber ?? 0))}번째 기본 공격 피해 +${formatNum(v.damagePercent ?? 0)}%`;
    case "crit-loop":
      return `치명타 확률 +${formatNum(v.points ?? 0)}%p, 치명타 시 Q/E 대기시간 ${formatNum(v.cooldownReduction ?? 0)}초 감소`;
    case "area-power":
      return `모든 피해 +${formatNum(v.allDamagePercent ?? 0)}%, 공격·스킬 범위 +${formatNum(v.percent ?? 0)}%`;
    case "split-attack":
      return `기본 공격 피해 +${formatNum(v.damagePercent ?? 0)}%, 근접 범위 +${formatNum(v.meleeRangePercent ?? 0)}%, 보조 공격 ${formatNum(v.projectileDamagePercent ?? 0)}% 피해`;
    case "chain-explosion":
      return `모든 피해 +${formatNum(v.allDamagePercent ?? 0)}%, 처치 시 반경 ${formatNum(v.radius ?? 0)}에 공격력 ${formatNum(v.damagePercent ?? 0)}% 폭발`;
    case "blade-projectile":
      return `기본 공격 피해 +${formatNum(v.damagePercent ?? 0)}%, 최대 사거리 ${formatNum(v.range ?? 0)}, ${formatNum(v.baseRange ?? 0)} 바깥 ${formatNum(v.falloffDamagePercent ?? 0)}% 피해`;
    case "execute-damage":
      return `체력 ${formatNum(v.hpThresholdPercent ?? 0)}% 이하 대상 피해 +${formatNum(v.damagePercent ?? 0)}%`;
    case "melee-arc-percent":
      return `기본 공격 피해 +${formatNum(v.damagePercent ?? 0)}%, 부채꼴 각도 +${formatNum(v.percent ?? 0)}%`;
    case "vulnerability-on-skill":
      return `스킬 적중 대상이 ${formatNum((v.durationMs ?? 0) / 1_000)}초간 받는 피해 +${formatNum(v.damagePercent ?? 0)}%`;
    case "fan-projectile":
      return `기본 공격 피해 +${formatNum(v.damagePercent ?? 0)}%, 보조 화살 ${formatNum(v.additionalProjectiles ?? 0)}발 ${formatNum(v.projectileDamagePercent ?? 0)}% 피해`;
    case "distance-damage":
      return `거리 ${formatNum(v.startDistance ?? 0)}부터 최대 +${formatNum(v.maxPercent ?? 0)}% 피해`;
    case "projectile-pierce":
      return `투사체 최대 ${formatNum(v.count ?? 0)}명 관통, 후속 ${formatNum(v.damagePercent ?? 0)}%/${formatNum(v.secondaryDamagePercent ?? 0)}% 피해`;
    case "projectile-ricochet":
      return `다른 적 ${formatNum(v.targets ?? 0)}명에게 ${formatNum(v.damagePercent ?? 0)}% 피해 도탄`;
    case "mark-on-skill":
      return `${formatNum((v.durationMs ?? 0) / 1_000)}초간 대상 기본 공격 피해 +${formatNum(v.autoAttackDamagePercent ?? 0)}%`;
    case "magic-area-percent":
      return `스킬 피해 +${formatNum(v.skillDamagePercent ?? 0)}%, 폭발 범위 +${formatNum(v.percent ?? 0)}%`;
    case "magic-chain":
      return `다른 적 ${formatNum(v.targets ?? 0)}명에게 ${formatNum(v.damagePercent ?? 0)}% 피해 연쇄`;
    case "skill-echo":
      return `Q/E 스킬이 ${formatNum((v.delayMs ?? 0) / 1_000)}초 뒤 ${formatNum(v.damagePercent ?? 0)}% 위력으로 반복`;
    default:
      return "증강 효과";
  }
}

function formatNum(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function ordinal(value: number): string {
  const map = { 2: "두", 3: "세", 4: "네" } as const;
  return (map as Record<number, string>)[value] ?? `${value}`;
}

const RAW_AUGMENT_DEFINITIONS: readonly AugmentDefinition[] = [
  ...GENERAL_AUGMENTS,
  ...MILESTONE_AUGMENTS,
];

export const AUGMENT_DEFINITIONS: readonly AugmentDefinition[] = RAW_AUGMENT_DEFINITIONS.map((definition) => ({
  ...definition,
  description: describeAugment(definition),
}));

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

/**
 * Migrates legacy saved-state augment stacks to the reworked pool.
 * Removed `ferocity` stacks convert 1:1 to `crit-loop` (capped at its max),
 * and any unknown/removed IDs are dropped so downstream lookups never throw.
 */
export function migrateAugmentStacks(stacks: Readonly<Record<string, number>>): AugmentStacks {
  const result: Partial<Record<AugmentId, number>> = {};
  for (const [id, count] of Object.entries(stacks)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) continue;
    const definition = AUGMENT_BY_ID.get(id as AugmentId);
    if (definition) {
      result[id as AugmentId] = Math.min(count, definition.maxStacks);
    } else if (id === "ferocity") {
      const target = AUGMENT_BY_ID.get("crit-loop")!;
      result["crit-loop"] = Math.min((result["crit-loop"] ?? 0) + count, target.maxStacks);
    }
  }
  return result;
}

function assertLevel(level: number): void {
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
    throw new RangeError(`level must be between 1 and ${MAX_LEVEL}`);
  }
}
