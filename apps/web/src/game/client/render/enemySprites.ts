export const SKELETON_SPRITE_PATH = "/Asset/sprites/skeleton-unarmed-8dir-walk-v1.png";
export const SKELETON_FRAME_SIZE = 160;
export const SKELETON_FRAME_COUNT = 8;

const ENEMY_MOVEMENT_FACING_THRESHOLD_SQ = 4;

export type EnemyFacingInput = Readonly<{
  movementX?: number;
  movementY?: number;
  targetDeltaX?: number;
  targetDeltaY?: number;
  aimRadians?: number;
  previousAngle?: number;
}>;

/**
 * Resolves the direction the rendered enemy is actually facing.
 * An explicit attack target wins for the attack frame, otherwise movement wins
 * over the server aim so a moving enemy cannot walk sideways with a stale aim.
 */
export function resolveEnemyFacingAngle(input: EnemyFacingInput): number {
  const movementX = finiteOrZero(input.movementX);
  const movementY = finiteOrZero(input.movementY);
  const targetDeltaX = input.targetDeltaX;
  const targetDeltaY = input.targetDeltaY;
  let angle = Number.isFinite(input.previousAngle) ? input.previousAngle as number : 90;

  if (
    Number.isFinite(targetDeltaX)
    && Number.isFinite(targetDeltaY)
    && (targetDeltaX !== 0 || targetDeltaY !== 0)
  ) {
    angle = radiansToDegrees(Math.atan2(targetDeltaY as number, targetDeltaX as number));
  } else if (movementX * movementX + movementY * movementY > ENEMY_MOVEMENT_FACING_THRESHOLD_SQ) {
    angle = radiansToDegrees(Math.atan2(movementY, movementX));
  } else if (Number.isFinite(input.aimRadians)) {
    angle = radiansToDegrees(input.aimRadians as number);
  }

  const normalized = (angle + 360) % 360;
  return (Math.round(normalized / 45) * 45) % 360;
}

function finiteOrZero(value: number | undefined): number {
  return Number.isFinite(value) ? value as number : 0;
}

function radiansToDegrees(radians: number): number {
  return radians * 180 / Math.PI;
}

/** Phaser aim angles use east as 0° and increase clockwise in screen space. */
export const SKELETON_ROW_BY_ANGLE: Readonly<Record<number, number>> = {
  // The generated sheet's visual facings do not follow its requested row order.
  // These rows are mapped from the direction each rendered skeleton actually faces.
  0: 3,
  45: 1,
  90: 0,
  135: 5,
  180: 2,
  225: 6,
  270: 4,
  315: 7,
};
