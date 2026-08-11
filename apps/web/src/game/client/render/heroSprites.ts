import type { HeroClassId } from "../../domain/types";

export const HERO_SPRITE_FRAME_SIZE = 362;
const HERO_SPRITE_DISPLAY_SIZE = 52.8;
export const HERO_SPRITE_SCALE = HERO_SPRITE_DISPLAY_SIZE / HERO_SPRITE_FRAME_SIZE;
export const HERO_DIRECTION_COUNT = 4;
const HERO_ANIMATION_ROW_COUNT = 3;
export const HERO_TOTAL_FRAME_COUNT = HERO_DIRECTION_COUNT * HERO_ANIMATION_ROW_COUNT;
export const HERO_WALK_PHASE_DURATION_MS = 140;

export const HERO_SPRITE_PATHS: Record<HeroClassId, string> = {
  swordsman: "/Asset/sprites/WarriorSprite.png",
  archer: "/Asset/sprites/ArcherSprite.png",
  mage: "/Asset/sprites/MageSprite.png",
};

export type HeroFacingDirection = "down" | "right" | "up" | "left";

export const DEFAULT_HERO_FACING: HeroFacingDirection = "down";

const HERO_DIRECTION_FRAMES: Record<HeroFacingDirection, number> = {
  down: 0,
  right: 1,
  up: 2,
  left: 3,
};

const MOVEMENT_EPSILON = 0.001;

/**
 * Cardinal input updates facing. Idle and diagonal input preserve the most
 * recent cardinal direction, so W then W+D keeps the up-facing sprite while
 * the movement vector remains diagonal.
 */
export function heroFacingForMovement(
  previous: HeroFacingDirection,
  movementX: number,
  movementY: number,
): HeroFacingDirection {
  const horizontal = Math.abs(movementX) > MOVEMENT_EPSILON ? Math.sign(movementX) : 0;
  const vertical = Math.abs(movementY) > MOVEMENT_EPSILON ? Math.sign(movementY) : 0;

  if (horizontal !== 0 && vertical !== 0) return previous;
  if (horizontal > 0) return "right";
  if (horizontal < 0) return "left";
  if (vertical > 0) return "down";
  if (vertical < 0) return "up";
  return previous;
}

/** Rows are ordered IDLE, LEFT FOOT WALK, RIGHT FOOT WALK. */
export function heroFrameForPose(facing: HeroFacingDirection, moving: boolean, time: number): number {
  const direction = HERO_DIRECTION_FRAMES[facing];
  if (!moving) return direction;
  const walkRow = Math.floor(time / HERO_WALK_PHASE_DURATION_MS) % 2 === 0 ? 1 : 2;
  return walkRow * HERO_DIRECTION_COUNT + direction;
}
