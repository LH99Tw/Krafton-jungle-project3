export type RenderPoint = Readonly<{ x: number; y: number }>;

type EnemyAttackCoordinates = Readonly<{
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  aim: number;
}>;

/**
 * Keeps an authoritative attack on the same delayed render timeline as its
 * interpolated attacker. A live rendered target is preferred; otherwise the
 * server's aim and attack distance are translated to the rendered origin.
 */
export function alignEnemyAttackToRenderTimeline(
  attack: EnemyAttackCoordinates,
  renderedAttacker: RenderPoint,
  renderedTarget: RenderPoint | null,
): RenderPoint {
  if (renderedTarget) return renderedTarget;
  const distance = Math.hypot(attack.targetX - attack.startX, attack.targetY - attack.startY);
  return {
    x: renderedAttacker.x + Math.cos(attack.aim) * distance,
    y: renderedAttacker.y + Math.sin(attack.aim) * distance,
  };
}
