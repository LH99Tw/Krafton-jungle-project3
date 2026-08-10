import { UPGRADE_MAP } from "../content/upgrades";
import type { HeroStats, UpgradeId } from "../domain/types";

export class ProgressionModel {
  level = 1;
  xp = 0;
  readonly stacks = new Map<UpgradeId, number>();

  constructor(public readonly stats: HeroStats) {}

  get xpToNext(): number {
    return 14 + this.level * 9;
  }

  addXp(amount: number): boolean {
    this.xp += amount;
    if (this.xp < this.xpToNext) return false;
    this.xp -= this.xpToNext;
    this.level += 1;
    return true;
  }

  applyUpgrade(id: UpgradeId): void {
    const definition = UPGRADE_MAP.get(id);
    if (!definition) return;
    const nextStack = Math.min((this.stacks.get(id) ?? 0) + 1, definition.maxStacks);
    this.stacks.set(id, nextStack);

    switch (id) {
      case "power":
        this.stats.attack += 3;
        break;
      case "haste":
        this.stats.attackIntervalMs = Math.max(150, Math.round(this.stats.attackIntervalMs * 0.88));
        break;
      case "vitality":
        this.stats.maxHp += 18;
        this.stats.hp = Math.min(this.stats.maxHp, this.stats.hp + 18);
        break;
      case "armor":
        this.stats.defense += 1;
        break;
      case "mobility":
        this.stats.moveSpeed = Math.round(this.stats.moveSpeed * 1.08);
        break;
      case "multishot":
        this.stats.projectileCount += 1;
        this.stats.attackRange = Math.round(this.stats.attackRange * 1.1);
        break;
      case "skill-power":
        this.stats.skillPower *= 1.22;
        break;
      default:
        break;
    }
  }

  has(id: UpgradeId): boolean {
    return (this.stacks.get(id) ?? 0) > 0;
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

