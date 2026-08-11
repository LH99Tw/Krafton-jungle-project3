import { PLAYER_VISION_RADIUS } from "@five-days/protocol";

export const MAX_VISION_REVEAL_SOURCES = 8;

export function isWithinPlayerVision(
  viewer: Readonly<{ x: number; y: number }>,
  candidate: Readonly<{ x: number; y: number }>,
  radius = PLAYER_VISION_RADIUS,
): boolean {
  return Math.hypot(candidate.x - viewer.x, candidate.y - viewer.y) <= radius;
}

export type VisionRevealSource = {
  id: string;
  x: number;
  y: number;
  radius: number;
};

export type VisionWallSegment = Readonly<{
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}>;

export type VisibilityRay = Readonly<{
  angle: number;
  distance: number;
}>;

const CORNER_EPSILON = 0.00001;
const CIRCLE_RAY_COUNT = 128;

/**
 * Casts deterministic 360-degree rays against the outside wall boundary.
 * Corner-adjacent rays prevent gaps at door jambs while the regular rays keep
 * the radius edge smooth in open space.
 */
export function computeVisibilityRays(
  origin: Readonly<{ x: number; y: number }>,
  radius: number,
  walls: readonly VisionWallSegment[],
): VisibilityRay[] {
  if (!(radius > 0)) return [];
  const angles: number[] = [];
  for (let index = 0; index < CIRCLE_RAY_COUNT; index += 1) {
    angles.push(-Math.PI + index * Math.PI * 2 / CIRCLE_RAY_COUNT);
  }
  for (const wall of walls) {
    for (const point of [{ x: wall.x1, y: wall.y1 }, { x: wall.x2, y: wall.y2 }]) {
      if (Math.hypot(point.x - origin.x, point.y - origin.y) > radius + 1) continue;
      const angle = Math.atan2(point.y - origin.y, point.x - origin.x);
      angles.push(angle - CORNER_EPSILON, angle, angle + CORNER_EPSILON);
    }
  }
  angles.sort((left, right) => left - right);
  const unique = angles.filter((angle, index) => index === 0 || Math.abs(angle - angles[index - 1]!) > 1e-8);
  return unique.map((angle) => ({ angle, distance: nearestWallDistance(origin, angle, radius, walls) }));
}

export function visibilityPolygonFromRays(
  origin: Readonly<{ x: number; y: number }>,
  rays: readonly VisibilityRay[],
  radius: number,
): Array<{ x: number; y: number }> {
  return rays.map((ray) => {
    const distance = Math.min(radius, ray.distance);
    return { x: origin.x + Math.cos(ray.angle) * distance, y: origin.y + Math.sin(ray.angle) * distance };
  });
}

export function computeVisibilityPolygon(
  origin: Readonly<{ x: number; y: number }>,
  radius: number,
  walls: readonly VisionWallSegment[],
): Array<{ x: number; y: number }> {
  return visibilityPolygonFromRays(origin, computeVisibilityRays(origin, radius, walls), radius);
}

function nearestWallDistance(
  origin: Readonly<{ x: number; y: number }>,
  angle: number,
  radius: number,
  walls: readonly VisionWallSegment[],
): number {
  const rayX = Math.cos(angle);
  const rayY = Math.sin(angle);
  let nearest = radius;
  for (const wall of walls) {
    const segmentX = wall.x2 - wall.x1;
    const segmentY = wall.y2 - wall.y1;
    const denominator = cross(rayX, rayY, segmentX, segmentY);
    if (Math.abs(denominator) < 1e-9) continue;
    const offsetX = wall.x1 - origin.x;
    const offsetY = wall.y1 - origin.y;
    const rayDistance = cross(offsetX, offsetY, segmentX, segmentY) / denominator;
    const segmentRatio = cross(offsetX, offsetY, rayX, rayY) / denominator;
    if (rayDistance >= 0 && rayDistance < nearest && segmentRatio >= 0 && segmentRatio <= 1) nearest = rayDistance;
  }
  return nearest;
}

function cross(leftX: number, leftY: number, rightX: number, rightY: number): number {
  return leftX * rightY - leftY * rightX;
}

/**
 * The player light always wins a slot. Remaining slots are deterministic so
 * future lantern updates do not make the fog edge flicker between sources.
 */
export function selectVisionRevealSources(
  player: VisionRevealSource,
  installedSources: Iterable<VisionRevealSource>,
  maximum = MAX_VISION_REVEAL_SOURCES,
): VisionRevealSource[] {
  if (maximum <= 0) return [];
  const unique = new Map<string, VisionRevealSource>();
  for (const source of installedSources) {
    if (source.id === player.id || source.radius <= 0) continue;
    unique.set(source.id, source);
  }
  return [player, ...[...unique.values()].sort((left, right) => left.id.localeCompare(right.id))]
    .slice(0, maximum);
}
