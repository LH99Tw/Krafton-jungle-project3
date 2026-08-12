export type AutoAttackTargetPoint = Readonly<{
  id: string;
  x: number;
  y: number;
}>;

type AutoAttackOrigin = Readonly<{
  x: number;
  y: number;
  aim: number;
}>;

function angularError(angle: number): number {
  return Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle)));
}

/**
 * Matches the authoritative GameCore targeting rule: prefer enemies inside
 * the cursor cone, but never stall auto attack when only an in-range enemy
 * outside that cone is available.
 */
export function selectAutoAttackTargets<T extends AutoAttackTargetPoint>(
  origin: AutoAttackOrigin,
  targets: Iterable<T>,
  range: number,
  coneHalfAngle: number,
  hasLineOfSight: (target: T) => boolean,
): T[] {
  const rangeSquared = range * range;
  const candidates = [...targets]
    .map((target) => {
      const dx = target.x - origin.x;
      const dy = target.y - origin.y;
      return {
        target,
        distanceSquared: dx * dx + dy * dy,
        angularError: angularError(Math.atan2(dy, dx) - origin.aim),
      };
    })
    .filter((candidate) => candidate.distanceSquared <= rangeSquared && hasLineOfSight(candidate.target))
    .sort((left, right) => left.distanceSquared - right.distanceSquared
      || left.target.id.localeCompare(right.target.id));
  const aimed = candidates.filter((candidate) => candidate.angularError <= coneHalfAngle);
  return (aimed.length > 0 ? aimed : candidates).map((candidate) => candidate.target);
}
