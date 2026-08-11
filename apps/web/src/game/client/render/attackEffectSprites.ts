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

export const BASIC_ATTACK_SPRITE_PATHS = Object.values(BASIC_ATTACK_SPRITES).map((sprite) => sprite.path);
