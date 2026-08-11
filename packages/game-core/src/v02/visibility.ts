export type VisionPoint = Readonly<{ x: number; y: number }>;
export type VisionWallSegment = Readonly<{ x1: number; y1: number; x2: number; y2: number }>;
export type VisibilityRay = Readonly<{ angle: number; distance: number }>;

export type WallSpatialIndex = Readonly<{
  cellSize: number;
  segments: readonly VisionWallSegment[];
  buckets: ReadonlyMap<string, readonly number[]>;
}>;

const CORNER_EPSILON = 0.00001;
const CIRCLE_RAY_COUNT = 128;
export const VISION_WALL_BUCKET_SIZE = 256;

export function createWallSpatialIndex(
  segments: readonly VisionWallSegment[],
  cellSize = VISION_WALL_BUCKET_SIZE,
): WallSpatialIndex {
  const mutable = new Map<string, number[]>();
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const minX = Math.floor(Math.min(segment.x1, segment.x2) / cellSize);
    const maxX = Math.floor(Math.max(segment.x1, segment.x2) / cellSize);
    const minY = Math.floor(Math.min(segment.y1, segment.y2) / cellSize);
    const maxY = Math.floor(Math.max(segment.y1, segment.y2) / cellSize);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const key = `${x}:${y}`;
        const bucket = mutable.get(key) ?? [];
        bucket.push(index);
        mutable.set(key, bucket);
      }
    }
  }
  return { cellSize, segments, buckets: mutable };
}

export function wallsNear(
  index: WallSpatialIndex,
  origin: VisionPoint,
  radius: number,
): VisionWallSegment[] {
  const minX = Math.floor((origin.x - radius) / index.cellSize);
  const maxX = Math.floor((origin.x + radius) / index.cellSize);
  const minY = Math.floor((origin.y - radius) / index.cellSize);
  const maxY = Math.floor((origin.y + radius) / index.cellSize);
  const ids = new Set<number>();
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      for (const id of index.buckets.get(`${x}:${y}`) ?? []) ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a - b).map((id) => index.segments[id]!);
}

export function computeVisibilityRays(
  origin: VisionPoint,
  radius: number,
  wallsOrIndex: readonly VisionWallSegment[] | WallSpatialIndex,
): VisibilityRay[] {
  if (!(radius > 0)) return [];
  const walls = Array.isArray(wallsOrIndex)
    ? wallsOrIndex
    : wallsNear(wallsOrIndex as WallSpatialIndex, origin, radius + 1);
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
  origin: VisionPoint,
  rays: readonly VisibilityRay[],
  radius: number,
): Array<{ x: number; y: number }> {
  return rays.map((ray) => {
    const distance = Math.min(radius, ray.distance);
    return { x: origin.x + Math.cos(ray.angle) * distance, y: origin.y + Math.sin(ray.angle) * distance };
  });
}

export function computeVisibilityPolygon(
  origin: VisionPoint,
  radius: number,
  wallsOrIndex: readonly VisionWallSegment[] | WallSpatialIndex,
): Array<{ x: number; y: number }> {
  return visibilityPolygonFromRays(origin, computeVisibilityRays(origin, radius, wallsOrIndex), radius);
}

export function pointInVisibilityPolygon(points: readonly VisionPoint[], x: number, y: number): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index]!;
    const b = points[previous]!;
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function nearestWallDistance(
  origin: VisionPoint,
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
