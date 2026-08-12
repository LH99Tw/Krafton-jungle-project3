import type { HeroClassId } from "../../domain/types";

export type BasicAttackSpriteSpec = {
  textureKey: string;
  animationKey: string;
  path: string;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  rows?: number;
  frameRate: number;
  repeat: number;
};

export const BASIC_ATTACK_SPRITES: Record<HeroClassId, BasicAttackSpriteSpec> = {
  swordsman: {
    textureKey: "basic-slash-8dir-v2-sprite",
    animationKey: "basic-slash-8dir-v2-play",
    path: "/images/effects/basic-slash-8dir-v2.png",
    frameWidth: 192,
    frameHeight: 192,
    frameCount: 6,
    rows: 8,
    frameRate: 30,
    repeat: 0,
  },
  archer: {
    textureKey: "basic-arrow-sprite",
    animationKey: "basic-arrow-flight",
    path: "/images/effects/basic-arrow-sheet.png",
    frameWidth: 128,
    frameHeight: 48,
    frameCount: 6,
    frameRate: 45,
    repeat: -1,
  },
  mage: {
    textureKey: "basic-magic-orb-sprite",
    animationKey: "basic-magic-orb-flight",
    path: "/images/effects/basic-magic-orb-sheet.png",
    frameWidth: 64,
    frameHeight: 64,
    frameCount: 8,
    frameRate: 48,
    repeat: -1,
  },
};

export type BasicAttackUpgradeLevel = 10 | 20 | 30;

function upgradedSprite(
  base: BasicAttackSpriteSpec,
  level: BasicAttackUpgradeLevel,
  path: string,
): BasicAttackSpriteSpec {
  return {
    ...base,
    textureKey: `${base.textureKey}-level-${level}`,
    animationKey: `${base.animationKey}-level-${level}`,
    path,
  };
}

export const BASIC_ATTACK_SPRITE_SETS: Record<HeroClassId, readonly BasicAttackSpriteSpec[]> = {
  swordsman: [
    BASIC_ATTACK_SPRITES.swordsman,
    upgradedSprite(BASIC_ATTACK_SPRITES.swordsman, 10, "/images/effects/level-upgrades/basic-slash-8dir-level-10.png"),
    upgradedSprite(BASIC_ATTACK_SPRITES.swordsman, 20, "/images/effects/level-upgrades/basic-slash-8dir-level-20.png"),
    upgradedSprite(BASIC_ATTACK_SPRITES.swordsman, 30, "/images/effects/level-upgrades/basic-slash-8dir-level-30.png"),
  ],
  archer: [
    BASIC_ATTACK_SPRITES.archer,
    upgradedSprite(BASIC_ATTACK_SPRITES.archer, 10, "/images/effects/level-upgrades/basic-arrow-level-10.png"),
    upgradedSprite(BASIC_ATTACK_SPRITES.archer, 20, "/images/effects/level-upgrades/basic-arrow-level-20.png"),
    upgradedSprite(BASIC_ATTACK_SPRITES.archer, 30, "/images/effects/level-upgrades/basic-arrow-level-30.png"),
  ],
  mage: [
    BASIC_ATTACK_SPRITES.mage,
    upgradedSprite(BASIC_ATTACK_SPRITES.mage, 10, "/images/effects/level-upgrades/basic-magic-orb-level-10.png"),
    upgradedSprite(BASIC_ATTACK_SPRITES.mage, 20, "/images/effects/level-upgrades/basic-magic-orb-level-20.png"),
    upgradedSprite(BASIC_ATTACK_SPRITES.mage, 30, "/images/effects/level-upgrades/basic-magic-orb-level-30.png"),
  ],
};

export const BASIC_ATTACK_ALL_SPRITES = Object.values(BASIC_ATTACK_SPRITE_SETS).flat();

export function basicAttackSpriteForLevel(classId: HeroClassId, level: number): BasicAttackSpriteSpec {
  const tierIndex = level >= 30 ? 3 : level >= 20 ? 2 : level >= 10 ? 1 : 0;
  return BASIC_ATTACK_SPRITE_SETS[classId][tierIndex]!;
}

export const SWORDSMAN_SLASH_DIRECTIONS = [
  "right",
  "down-right",
  "down",
  "down-left",
  "left",
  "up-left",
  "up",
  "up-right",
] as const;

export type SwordsmanSlashDirection = (typeof SWORDSMAN_SLASH_DIRECTIONS)[number];

export function swordsmanSlashDirectionForAim(angle: number): SwordsmanSlashDirection {
  const normalized = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const octant = Math.round(normalized / (Math.PI / 4)) % 8;
  return SWORDSMAN_SLASH_DIRECTIONS[octant];
}

/**
 * The authored slash sheet stores the blade's trailing edge toward the named
 * row, so its visual travel direction is opposite to the world-space attack.
 */
export function swordsmanSlashAnimationDirectionForAim(angle: number): SwordsmanSlashDirection {
  return swordsmanSlashDirectionForAim(angle + Math.PI);
}

export const BASIC_ATTACK_SPRITE_PATHS = BASIC_ATTACK_ALL_SPRITES.map((sprite) => sprite.path);
