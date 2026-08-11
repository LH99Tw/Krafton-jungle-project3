import type { HeroClassId } from "../../domain/types";

export const HERO_SPRITE_FRAME_SIZE = 32;
export const HERO_SPRITE_SCALE = 1.65;

export const HERO_SPRITE_PATHS: Record<HeroClassId, string> = {
  swordsman: "/Asset/sprites/warrior-8dir-32.png",
  archer: "/Asset/sprites/archer-8dir-32.png",
  mage: "/Asset/sprites/mage-8dir-32.png",
};

/**
 * Sprite frames run clockwise from east in 45-degree increments:
 * E, SE, S, SW, W, NW, N, NE.
 */
export function heroFrameForAimAngle(aimAngle: number): number {
  return ((Math.round(aimAngle / (Math.PI / 4)) % 8) + 8) % 8;
}
