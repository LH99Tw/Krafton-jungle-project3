export type AimPoint = Readonly<{ x: number; y: number }>;

export function normalizeAimAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export function aimAngleBetween(origin: AimPoint, target: AimPoint): number {
  return normalizeAimAngle(Math.atan2(target.y - origin.y, target.x - origin.x));
}
