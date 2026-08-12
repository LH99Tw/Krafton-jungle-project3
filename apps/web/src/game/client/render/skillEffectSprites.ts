import type { HeroClassId } from "../../domain/types";

export type AutoSkillEffectId = "q" | "e";

export type SkillEffectSpriteSpec = Readonly<{
  textureKey: string;
  animationKey: string;
  path: string;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  frameRate: number;
}>;

function effectSpec(classId: HeroClassId, skillId: AutoSkillEffectId, frameRate = 20): SkillEffectSpriteSpec {
  return {
    textureKey: `skill-effect-${classId}-${skillId}`,
    animationKey: `skill-effect-${classId}-${skillId}-play`,
    path: `/images/effects/skills/${classId}-${skillId}-sheet.png`,
    frameWidth: 256,
    frameHeight: 256,
    frameCount: 6,
    frameRate,
  };
}

export const SKILL_EFFECT_SPRITES: Readonly<Record<HeroClassId, Readonly<Record<AutoSkillEffectId, SkillEffectSpriteSpec>>>> = {
  swordsman: { q: effectSpec("swordsman", "q"), e: effectSpec("swordsman", "e") },
  archer: { q: effectSpec("archer", "q"), e: effectSpec("archer", "e", 10) },
  mage: { q: effectSpec("mage", "q"), e: effectSpec("mage", "e") },
};

export const SKILL_EFFECT_ALL_SPRITES = Object.values(SKILL_EFFECT_SPRITES).flatMap((skills) => Object.values(skills));
export const SKILL_EFFECT_SPRITE_PATHS = SKILL_EFFECT_ALL_SPRITES.map((sprite) => sprite.path);
