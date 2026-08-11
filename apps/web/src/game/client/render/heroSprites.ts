import type { HeroClassId } from "../../domain/types";

export const HERO_SPRITE_FRAME_SIZE = 32;
export const HERO_SPRITE_SCALE = 1.65;
export const HERO_DIRECTION_COUNT = 8;
export const HERO_ANIMATION_ROW_COUNT = 3;
export const HERO_TOTAL_FRAME_COUNT = HERO_DIRECTION_COUNT * HERO_ANIMATION_ROW_COUNT;
export const HERO_WALK_PHASE_DURATION_MS = 140;

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
  return ((Math.round(aimAngle / (Math.PI / 4)) % HERO_DIRECTION_COUNT) + HERO_DIRECTION_COUNT) % HERO_DIRECTION_COUNT;
}

/** Rows are ordered IDLE, LEFT FOOT WALK, RIGHT FOOT WALK. */
export function heroFrameForPose(aimAngle: number, moving: boolean, time: number): number {
  const direction = heroFrameForAimAngle(aimAngle);
  if (!moving) return direction;
  const walkRow = Math.floor(time / HERO_WALK_PHASE_DURATION_MS) % 2 === 0 ? 1 : 2;
  return walkRow * HERO_DIRECTION_COUNT + direction;
}
