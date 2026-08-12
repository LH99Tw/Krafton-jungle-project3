import type { HeroClassId } from "../../domain/types";

export const HERO_SPRITE_FRAME_SIZE = 362;
const HERO_SPRITE_DISPLAY_SIZE = 105.6;
export const HERO_SPRITE_SCALE = HERO_SPRITE_DISPLAY_SIZE / HERO_SPRITE_FRAME_SIZE;
export const HERO_DIRECTION_COUNT = 4;
const HERO_ANIMATION_ROW_COUNT = 3;
export const HERO_TOTAL_FRAME_COUNT = HERO_DIRECTION_COUNT * HERO_ANIMATION_ROW_COUNT;
export const HERO_WALK_PHASE_DURATION_MS = 140;

export const HERO_SPRITE_PATHS: Record<HeroClassId, string> = {
  swordsman: "/Asset/sprites/WarriorSprite.png",
  archer: "/Asset/sprites/ArcherSprite.png",
  // Versioned because /Asset responses are cached for a day in production.
  mage: "/Asset/sprites/MageSprite-v2.png",
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

export function heroFacingForAim(angle: number): HeroFacingDirection {
  const directions: HeroFacingDirection[] = ["right", "down", "left", "up"];
  const normalized = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const sector = Math.floor((normalized + Math.PI / 4 + Number.EPSILON * 16) / (Math.PI / 2));
  return directions[sector % directions.length];
}

/** Attack facing overrides movement while the short attack pose is active. */
export function heroFacingForPose(
  previous: HeroFacingDirection,
  movementX: number,
  movementY: number,
  attackFacing?: HeroFacingDirection,
): HeroFacingDirection {
  return attackFacing ?? heroFacingForMovement(previous, movementX, movementY);
}

/** Rows are ordered IDLE, LEFT FOOT WALK, RIGHT FOOT WALK. */
export function heroFrameForPose(facing: HeroFacingDirection, moving: boolean, animationElapsedMs: number): number {
  const direction = HERO_DIRECTION_FRAMES[facing];
  if (!moving) return direction;

  // A neutral pose between footfalls prevents the two extreme walk poses from
  // reading as a hop: WALK1 -> IDLE -> WALK2 -> IDLE -> WALK1.
  const phase = Math.floor(Math.max(0, animationElapsedMs) / HERO_WALK_PHASE_DURATION_MS) % 4;
  const walkRow = phase === 0 ? 1 : phase === 2 ? 2 : 0;
  return walkRow * HERO_DIRECTION_COUNT + direction;
}
