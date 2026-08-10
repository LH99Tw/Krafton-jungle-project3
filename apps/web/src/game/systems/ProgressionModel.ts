import {
  AUGMENT_BY_ID,
  MAX_LEVEL,
  addExperience,
  xpRequiredForNextLevel,
  type AugmentId,
  type AugmentStacks,
} from "@five-days/game-core";
import { UPGRADE_MAP } from "../content/upgrades";
import type { HeroStats, UpgradeId } from "../domain/types";

export class ProgressionModel {
  level = 1;
  xp = 0;
  readonly stacks = new Map<UpgradeId, number>();
  private readonly pendingDraftLevels: number[] = [];

  constructor(public readonly stats: HeroStats) {}

  get xpToNext(): number {
    return xpRequiredForNextLevel(this.level) ?? 0;
  }

  get atLevelCap(): boolean {
    return this.level >= MAX_LEVEL;
  }

  addXp(amount: number): boolean {
    const result = addExperience({ level: this.level, xp: this.xp }, Math.max(0, Math.round(amount)));
    this.level = result.progress.level;
    this.xp = result.progress.xp;
    this.pendingDraftLevels.push(...result.gainedLevels);
    return result.gainedLevels.length > 0;
  }

  consumeNextDraftLevel(): number | null {
    return this.pendingDraftLevels.shift() ?? null;
  }

  get pendingDraftCount(): number {
    return this.pendingDraftLevels.length;
  }

  applyUpgrade(id: UpgradeId): void {
    const definition = UPGRADE_MAP.get(id);
    const augment = AUGMENT_BY_ID.get(id as AugmentId);
    if (!definition || !augment) return;
    const current = this.stacks.get(id) ?? 0;
    if (current >= definition.maxStacks) return;
    this.stacks.set(id, current + 1);

    const amount = augment.effect.values.amount ?? 0;
    const percent = augment.effect.values.percent ?? 0;
    switch (augment.effect.kind) {
      case "attack-flat":
        this.stats.attack += amount;
        break;
      case "attack-speed-percent":
        this.stats.attackIntervalMs = Math.max(
          120,
          Math.round(this.stats.attackIntervalMs * (1 - percent / 100)),
        );
        break;
      case "class-adaptive-multishot":
        if (this.stats.attackRange <= 160) this.stats.attackRange = Math.round(this.stats.attackRange * 1.2);
        else this.stats.projectileCount += augment.effect.values.projectileCount ?? 1;
        break;
      case "skill-power-percent":
        this.stats.skillPower *= 1 + percent / 100;
        break;
      case "attack-area-percent":
        this.stats.attackRange = Math.round(this.stats.attackRange * (1 + percent / 100));
        break;
      default:
        break;
    }
  }

  has(id: UpgradeId): boolean {
    return (this.stacks.get(id) ?? 0) > 0;
  }

  get sharedStacks(): AugmentStacks {
    const result: Partial<Record<AugmentId, number>> = {};
    for (const [id, stack] of this.stacks) {
      if (AUGMENT_BY_ID.has(id as AugmentId)) result[id as AugmentId] = stack;
    }
    return result;
  }

  get powerScore(): number {
    return Math.round(
      this.stats.attack * 7 +
        this.stats.maxHp * 0.8 +
        this.stats.defense * 12 +
        (700 / this.stats.attackIntervalMs) * 18 +
        this.stats.projectileCount * 16 +
        (this.level - 1) * 22,
    );
  }
}
