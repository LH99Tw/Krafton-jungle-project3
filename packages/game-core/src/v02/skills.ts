import type { HeroClassId } from "@five-days/protocol";

export type AutoSkillId = "q" | "e";
export type AutoSkillTargeting = "single" | "area" | "line";

export type AutoSkillDefinition = Readonly<{
  id: AutoSkillId;
  cooldownSeconds: number;
  targeting: AutoSkillTargeting;
  range: number;
  radius: number;
  damageMultiplier: number;
  maxTargets: number;
  dashDistance?: number;
}>;

/**
 * Q/E are survivor-like weapons: they acquire a target and fire on cooldown.
 * Q is the class signature; E deliberately covers a different target pattern.
 */
export const AUTO_SKILLS: Readonly<Record<HeroClassId, Readonly<Record<AutoSkillId, AutoSkillDefinition>>>> = {
  swordsman: {
    q: { id: "q", cooldownSeconds: 5, targeting: "area", range: 165, radius: 165, damageMultiplier: 1.35, maxTargets: 12 },
    e: { id: "e", cooldownSeconds: 7, targeting: "line", range: 245, radius: 42, damageMultiplier: 1.55, maxTargets: 5, dashDistance: 72 },
  },
  archer: {
    q: { id: "q", cooldownSeconds: 4.2, targeting: "single", range: 520, radius: 16, damageMultiplier: 2.4, maxTargets: 1 },
    e: { id: "e", cooldownSeconds: 7.2, targeting: "area", range: 460, radius: 145, damageMultiplier: 0.82, maxTargets: 12 },
  },
  mage: {
    q: { id: "q", cooldownSeconds: 5.2, targeting: "single", range: 430, radius: 18, damageMultiplier: 2.2, maxTargets: 1 },
    e: { id: "e", cooldownSeconds: 6.9, targeting: "area", range: 430, radius: 175, damageMultiplier: 1.1, maxTargets: 14 },
  },
};

export function autoSkillDefinition(heroClass: HeroClassId, skillId: AutoSkillId): AutoSkillDefinition {
  return AUTO_SKILLS[heroClass][skillId];
}
