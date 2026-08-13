export const SKELETON_SPRITE_PATH = "/Asset/sprites/skeleton-unarmed-8dir-walk-v1.png";
export const GOBLIN_SPRITE_PATH = "/Asset/sprites/goblin-unarmed-8dir-walk-v1.png";
export const DEMON_SPRITE_PATH = "/Asset/sprites/demon-unarmed-8dir-walk-v1.png";
export const FROG_UPGRADED_SPRITE_PATH = "/Asset/sprites/frog-upgraded-8dir-walk-v1.png";
export const SUCCUBUS_UPGRADED_SPRITE_PATH = "/Asset/sprites/succubus-upgraded-8dir-walk-v1.png";
export const GOLEM_UPGRADED_SPRITE_PATH = "/Asset/sprites/golem-upgraded-8dir-walk-v1.png";
export const HIDDEN_ENT_SPRITE_PATH = "/Asset/sprites/hidden-ent-7frame-8dir-walk-v2.png";
export const HIDDEN_STONE_GOLEM_SPRITE_PATH = "/Asset/sprites/hidden-stone-golem-7frame-8dir-walk-v2.png";
export const HIDDEN_DULLAHAN_SPRITE_PATH = "/Asset/sprites/hidden-dullahan-7frame-8dir-walk-v2.png";
export const SKELETON_FRAME_SIZE = 160;
export const SKELETON_FRAME_COUNT = 8;
export const HIDDEN_ENEMY_FRAME_COUNT = 7;

export const FIELD_ENEMY_TEXTURE_BY_ZONE: Readonly<Record<number, string>> = {
  1: "enemy-goblin-unarmed",
  2: "enemy-skeleton-unarmed",
  3: "enemy-lesser-demon-unarmed",
};

export const UPGRADED_FIELD_ENEMY_TEXTURE_BY_ZONE: Readonly<Record<number, string>> = {
  1: "enemy-frog-upgraded",
  2: "enemy-golem-upgraded",
  3: "enemy-succubus-upgraded",
};

export const HIDDEN_ENEMY_TEXTURE_BY_ZONE: Readonly<Record<number, string>> = {
  // Keep the runtime keys versioned as well as the files. Phaser's global
  // texture cache survives local HMR, so reusing the v1 keys can pair a
  // cached 8-frame sheet with the v2 7-frame animation boundaries.
  1: "enemy-hidden-ent-v2",
  2: "enemy-hidden-stone-golem-v2",
  3: "enemy-hidden-dullahan-v2",
};

export function hiddenEnemyTextureForZone(zone: number): string {
  return HIDDEN_ENEMY_TEXTURE_BY_ZONE[zone] ?? HIDDEN_ENEMY_TEXTURE_BY_ZONE[3]!;
}

export function fieldEnemyTextureForZone(zone: number): string {
  return FIELD_ENEMY_TEXTURE_BY_ZONE[zone] ?? FIELD_ENEMY_TEXTURE_BY_ZONE[3]!;
}

export function usesUpgradedFieldEnemySkin(enemyId: string): boolean {
  return stableEnemyHash(enemyId) % 30 === 0;
}

export function fieldEnemyTextureForSpawn(zone: number, enemyId: string): string {
  if (!usesUpgradedFieldEnemySkin(enemyId)) return fieldEnemyTextureForZone(zone);
  return UPGRADED_FIELD_ENEMY_TEXTURE_BY_ZONE[zone] ?? UPGRADED_FIELD_ENEMY_TEXTURE_BY_ZONE[3]!;
}

function stableEnemyHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

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

const STANDARD_ENEMY_ROW_BY_ANGLE: Readonly<Record<number, number>> = {
  0: 2, 45: 1, 90: 0, 135: 7, 180: 6, 225: 5, 270: 4, 315: 3,
};

export function enemyFrameRow(textureKey: string, angle: number): number {
  const rows = textureKey === "enemy-skeleton-unarmed" ? SKELETON_ROW_BY_ANGLE : STANDARD_ENEMY_ROW_BY_ANGLE;
  return rows[angle] ?? 0;
}
