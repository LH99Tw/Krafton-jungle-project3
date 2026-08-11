import type { GridPosition } from "./map";

/**
 * Continuous ("semi-seamless") world layout for a zone.
 *
 * Every grid room is placed inside a fixed world rectangle, and every pair of
 * orthogonally connected rooms is joined by a physical corridor rectangle.
 * The union of room + corridor rectangles is the walkable surface, so a player
 * walks continuously through a passageway between rooms instead of teleporting
 * across discrete screens. Room/zone/waypoint logic is unchanged.
 */

const WORLD_ROOM_WIDTH = 1_280;
const WORLD_ROOM_HEIGHT = 720;
/** Physical gap between adjacent rooms. */
const WORLD_ROOM_GAP = 240;
/** Walkable passage width. Keeping this narrow makes the connection read as a corridor. */
const WORLD_CORRIDOR_WIDTH = 160;

export type WorldRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type WorldWallSegment = Readonly<{ x1: number; y1: number; x2: number; y2: number }>;
export type WalkableSpatialIndex = Readonly<{
  rects: readonly WorldRect[];
  cellSize: number;
  rows: ReadonlyMap<number, ReadonlyMap<number, readonly WorldRect[]>>;
}>;

type NavigationNode = Readonly<{ x: number; y: number; column: number; row: number }>;
const discNavigationGridCache = new WeakMap<readonly WorldRect[], Map<string, ReadonlyMap<string, NavigationNode>>>();
const discSampleCache = new Map<number, ReadonlyArray<Readonly<{ x: number; y: number }>>>();

/** Returns the outside boundary of the union of axis-aligned walkable rectangles. */
export function boundarySegments(rects: readonly WorldRect[]): WorldWallSegment[] {
  const segments: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (const rect of rects) {
    const candidates = [
      { axis: "h", fixed: rect.y, start: rect.x, end: rect.x + rect.width, outsideX: 0, outsideY: -0.1 },
      { axis: "h", fixed: rect.y + rect.height, start: rect.x, end: rect.x + rect.width, outsideX: 0, outsideY: 0.1 },
      { axis: "v", fixed: rect.x, start: rect.y, end: rect.y + rect.height, outsideX: -0.1, outsideY: 0 },
      { axis: "v", fixed: rect.x + rect.width, start: rect.y, end: rect.y + rect.height, outsideX: 0.1, outsideY: 0 },
    ] as const;
    for (const edge of candidates) {
      const cuts = new Set([edge.start, edge.end]);
      for (const other of rects) {
        cuts.add(edge.axis === "h" ? other.x : other.y);
        cuts.add(edge.axis === "h" ? other.x + other.width : other.y + other.height);
      }
      const ordered = [...cuts].filter((value) => value >= edge.start && value <= edge.end).sort((a, b) => a - b);
      for (let index = 1; index < ordered.length; index += 1) {
        const start = ordered[index - 1]!;
        const end = ordered[index]!;
        if (end - start < 0.01) continue;
        const midpoint = (start + end) / 2;
        const x = edge.axis === "h" ? midpoint + edge.outsideX : edge.fixed + edge.outsideX;
        const y = edge.axis === "h" ? edge.fixed + edge.outsideY : midpoint + edge.outsideY;
        if (rects.some((other) => pointInRect(x, y, other))) continue;
        segments.push(edge.axis === "h"
          ? { x1: start, y1: edge.fixed, x2: end, y2: edge.fixed }
          : { x1: edge.fixed, y1: start, x2: edge.fixed, y2: end });
      }
    }
  }
  const sorted = segments.sort((left, right) => left.y1 - right.y1 || left.x1 - right.x1 || left.y2 - right.y2 || left.x2 - right.x2);
  const merged: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (const segment of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.y1 === previous.y2 && segment.y1 === segment.y2 && previous.y1 === segment.y1 && Math.abs(previous.x2 - segment.x1) < 0.01) previous.x2 = segment.x2;
    else if (previous && previous.x1 === previous.x2 && segment.x1 === segment.x2 && previous.x1 === segment.x1 && Math.abs(previous.y2 - segment.y1) < 0.01) previous.y2 = segment.y2;
    else merged.push({ ...segment });
  }
  return merged;
}

/** World rectangle occupied by the grid room at `position`. */
export function roomWorldRect(position: GridPosition): WorldRect {
  return {
    x: position.x * (WORLD_ROOM_WIDTH + WORLD_ROOM_GAP),
    y: position.y * (WORLD_ROOM_HEIGHT + WORLD_ROOM_GAP),
    width: WORLD_ROOM_WIDTH,
    height: WORLD_ROOM_HEIGHT,
  };
}

/** World center of a grid room (used for spawns and waypoints). */
export function roomWorldCenter(position: GridPosition): Readonly<{ x: number; y: number }> {
  const rect = roomWorldRect(position);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Dedicated world rectangle for the final boss arena. */
export function bossWorldRect(): WorldRect {
  return { x: 5 * (WORLD_ROOM_WIDTH + WORLD_ROOM_GAP), y: 0, width: WORLD_ROOM_WIDTH, height: WORLD_ROOM_HEIGHT };
}

/**
 * Corridor rectangle joining two orthogonally connected grid rooms.
 * Passages are centered on the shared room edge and remain deliberately narrow.
 */
export function corridorRectBetween(left: GridPosition, right: GridPosition): WorldRect | null {
  const leftRect = roomWorldRect(left);
  const rightRect = roomWorldRect(right);
  // left is north of right (y grows downward).
  if (left.x === right.x && left.y + 1 === right.y) {
    return { x: leftRect.x + (WORLD_ROOM_WIDTH - WORLD_CORRIDOR_WIDTH) / 2, y: leftRect.y + WORLD_ROOM_HEIGHT, width: WORLD_CORRIDOR_WIDTH, height: WORLD_ROOM_GAP };
  }
  if (left.x === right.x && left.y - 1 === right.y) {
    return { x: rightRect.x + (WORLD_ROOM_WIDTH - WORLD_CORRIDOR_WIDTH) / 2, y: rightRect.y + WORLD_ROOM_HEIGHT, width: WORLD_CORRIDOR_WIDTH, height: WORLD_ROOM_GAP };
  }
  // left is west of right.
  if (left.x + 1 === right.x && left.y === right.y) {
    return { x: leftRect.x + WORLD_ROOM_WIDTH, y: leftRect.y + (WORLD_ROOM_HEIGHT - WORLD_CORRIDOR_WIDTH) / 2, width: WORLD_ROOM_GAP, height: WORLD_CORRIDOR_WIDTH };
  }
  if (left.x - 1 === right.x && left.y === right.y) {
    return { x: rightRect.x + WORLD_ROOM_WIDTH, y: rightRect.y + (WORLD_ROOM_HEIGHT - WORLD_CORRIDOR_WIDTH) / 2, width: WORLD_ROOM_GAP, height: WORLD_CORRIDOR_WIDTH };
  }
  return null;
}

function rectsFromRooms(rooms: ReadonlyMap<string, GridPosition>, corridorPairs: ReadonlyArray<readonly [GridPosition, GridPosition]>): WorldRect[] {
  const rects: WorldRect[] = [];
  for (const position of rooms.values()) rects.push(roomWorldRect(position));
  for (const [left, right] of corridorPairs) {
    const corridor = corridorRectBetween(left, right);
    if (corridor) rects.push(corridor);
  }
  return rects;
}

function pointInRect(x: number, y: number, rect: WorldRect): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export function createWalkableSpatialIndex(
  rects: readonly WorldRect[],
  cellSize = 256,
): WalkableSpatialIndex {
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError("cellSize must be positive");
  const rows = new Map<number, Map<number, WorldRect[]>>();
  for (const rect of rects) {
    const minColumn = Math.floor(rect.x / cellSize);
    const maxColumn = Math.floor((rect.x + Math.max(0, rect.width - Number.EPSILON)) / cellSize);
    const minRow = Math.floor(rect.y / cellSize);
    const maxRow = Math.floor((rect.y + Math.max(0, rect.height - Number.EPSILON)) / cellSize);
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let column = minColumn; column <= maxColumn; column += 1) {
        const columns = rows.get(row) ?? new Map<number, WorldRect[]>();
        const bucket = columns.get(column) ?? [];
        bucket.push(rect);
        columns.set(column, bucket);
        rows.set(row, columns);
      }
    }
  }
  return { rects, cellSize, rows };
}

function isWalkableIndexedPoint(index: WalkableSpatialIndex, x: number, y: number): boolean {
  const row = Math.floor(y / index.cellSize);
  const column = Math.floor(x / index.cellSize);
  for (const rect of index.rows.get(row)?.get(column) ?? []) if (pointInRect(x, y, rect)) return true;
  return false;
}

/** True when the world point is on a walkable surface (room or corridor). */
function isWalkablePoint(rects: readonly WorldRect[], x: number, y: number): boolean {
  for (const rect of rects) if (pointInRect(x, y, rect)) return true;
  return false;
}

/** True when a circular actor can stand at the world point without touching a wall. */
export function isWalkableDiscPoint(
  rects: readonly WorldRect[],
  x: number,
  y: number,
  radius: number,
): boolean {
  if (!isWalkablePoint(rects, x, y)) return false;
  for (const sample of discSamples(radius)) {
    if (!isWalkablePoint(rects, x + sample.x, y + sample.y)) return false;
  }
  return true;
}

/** Exact spatially-indexed equivalent of isWalkableDiscPoint. */
export function isWalkableDiscPointIndexed(
  index: WalkableSpatialIndex,
  x: number,
  y: number,
  radius: number,
): boolean {
  if (!isWalkableIndexedPoint(index, x, y)) return false;
  for (const sample of discSamples(radius)) {
    if (!isWalkableIndexedPoint(index, x + sample.x, y + sample.y)) return false;
  }
  return true;
}

function discSamples(radius: number): readonly Readonly<{ x: number; y: number }>[] {
  const samples = Math.max(8, Math.ceil(radius * Math.PI / 6));
  const key = radius * 1_000 + samples;
  const cached = discSampleCache.get(key);
  if (cached) return cached;
  const points = Array.from({ length: samples }, (_, sample) => {
    const angle = sample * Math.PI * 2 / samples;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
  discSampleCache.set(key, points);
  return points;
}

export function isWalkableDiscLine(
  rects: readonly WorldRect[],
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
): boolean {
  const distance = Math.hypot(toX - fromX, toY - fromY);
  const steps = Math.max(1, Math.ceil(distance / 8));
  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    if (!isWalkableDiscPoint(
      rects,
      fromX + (toX - fromX) * progress,
      fromY + (toY - fromY) * progress,
      radius,
    )) return false;
  }
  return true;
}

export function isWalkableDiscLineIndexed(
  index: WalkableSpatialIndex,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
): boolean {
  const distance = Math.hypot(toX - fromX, toY - fromY);
  const steps = Math.max(1, Math.ceil(distance / 8));
  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    if (!isWalkableDiscPointIndexed(
      index,
      fromX + (toX - fromX) * progress,
      fromY + (toY - fromY) * progress,
      radius,
    )) return false;
  }
  return true;
}

/**
 * Finds a collision-safe waypoint path across the union of walkable rectangles.
 * A coarse A* grid keeps recovery planning cheap; line-of-sight smoothing keeps
 * the resulting follower movement from looking grid-bound.
 */
export function findWalkableDiscPath(
  rects: readonly WorldRect[],
  from: Readonly<{ x: number; y: number }>,
  to: Readonly<{ x: number; y: number }>,
  radius: number,
  cellSize = 48,
  maxVisited = 6_000,
): readonly Readonly<{ x: number; y: number }>[] | null {
  if (rects.length === 0
    || !isWalkableDiscPoint(rects, from.x, from.y, radius)
    || !isWalkableDiscPoint(rects, to.x, to.y, radius)) return null;
  if (isWalkableDiscLine(rects, from.x, from.y, to.x, to.y, radius)) return [{ ...to }];

  const keyOf = (column: number, row: number) => `${column}:${row}`;
  const variantKey = `${radius}:${cellSize}`;
  let variants = discNavigationGridCache.get(rects);
  let nodes = variants?.get(variantKey);
  if (!nodes) {
    const minX = Math.min(...rects.map((rect) => rect.x)) + radius + 1;
    const minY = Math.min(...rects.map((rect) => rect.y)) + radius + 1;
    const maxX = Math.max(...rects.map((rect) => rect.x + rect.width)) - radius - 1;
    const maxY = Math.max(...rects.map((rect) => rect.y + rect.height)) - radius - 1;
    const columns = Math.max(1, Math.floor((maxX - minX) / cellSize) + 1);
    const rows = Math.max(1, Math.floor((maxY - minY) / cellSize) + 1);
    const built = new Map<string, NavigationNode>();
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const point = { x: minX + column * cellSize, y: minY + row * cellSize };
        if (isWalkableDiscPoint(rects, point.x, point.y, radius)) {
          built.set(keyOf(column, row), { ...point, column, row });
        }
      }
    }
    nodes = built;
    variants ??= new Map();
    variants.set(variantKey, nodes);
    discNavigationGridCache.set(rects, variants);
  }

  const starts = [...nodes.entries()]
    .map(([key, point]) => ({ key, point, distance: Math.hypot(point.x - from.x, point.y - from.y) }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 24)
    .filter(({ point }) => isWalkableDiscLine(rects, from.x, from.y, point.x, point.y, radius));
  if (starts.length === 0) return null;

  const queue: Array<{ key: string; score: number }> = [];
  const enqueue = (entry: { key: string; score: number }) => {
    queue.push(entry);
    let index = queue.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (queue[parent]!.score <= entry.score) break;
      queue[index] = queue[parent]!;
      index = parent;
    }
    queue[index] = entry;
  };
  const dequeue = (): { key: string; score: number } | undefined => {
    const first = queue[0];
    const tail = queue.pop();
    if (!first || !tail || queue.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= queue.length) break;
      const child = right < queue.length && queue[right]!.score < queue[left]!.score ? right : left;
      if (queue[child]!.score >= tail.score) break;
      queue[index] = queue[child]!;
      index = child;
    }
    queue[index] = tail;
    return first;
  };
  const cameFrom = new Map<string, string>();
  const costs = new Map<string, number>();
  for (const start of starts) {
    costs.set(start.key, start.distance);
    enqueue({ key: start.key, score: start.distance + Math.hypot(to.x - start.point.x, to.y - start.point.y) });
  }
  const directions = [-1, 0, 1].flatMap((row) => [-1, 0, 1]
    .filter((column) => column !== 0 || row !== 0)
    .map((column) => ({ column, row })));
  let goalKey: string | null = null;
  let visited = 0;
  const closed = new Set<string>();

  while (queue.length > 0 && visited < maxVisited) {
    const currentKey = dequeue()?.key;
    if (!currentKey || closed.has(currentKey)) continue;
    closed.add(currentKey);
    visited += 1;
    const current = nodes.get(currentKey)!;
    if (isWalkableDiscLine(rects, current.x, current.y, to.x, to.y, radius)) {
      goalKey = currentKey;
      break;
    }
    for (const direction of directions) {
      const nextKey = keyOf(current.column + direction.column, current.row + direction.row);
      const next = nodes.get(nextKey);
      if (!next || !isWalkableDiscLine(rects, current.x, current.y, next.x, next.y, radius)) continue;
      const candidate = (costs.get(currentKey) ?? 0) + Math.hypot(next.x - current.x, next.y - current.y);
      if (candidate >= (costs.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue;
      cameFrom.set(nextKey, currentKey);
      costs.set(nextKey, candidate);
      enqueue({ key: nextKey, score: candidate + Math.hypot(to.x - next.x, to.y - next.y) });
    }
  }
  if (!goalKey) return null;

  const gridPath: Readonly<{ x: number; y: number }>[] = [];
  let cursor: string | undefined = goalKey;
  while (cursor) {
    const point = nodes.get(cursor)!;
    gridPath.push({ x: point.x, y: point.y });
    cursor = cameFrom.get(cursor);
  }
  gridPath.reverse();
  const candidates = [...gridPath, { ...to }];
  const smoothed: Readonly<{ x: number; y: number }>[] = [];
  let anchor = from;
  for (let index = 0; index < candidates.length;) {
    let furthest = index;
    for (let candidate = index; candidate < candidates.length; candidate += 1) {
      const point = candidates[candidate]!;
      if (isWalkableDiscLine(rects, anchor.x, anchor.y, point.x, point.y, radius)) furthest = candidate;
      else break;
    }
    const waypoint = candidates[furthest]!;
    smoothed.push(waypoint);
    anchor = waypoint;
    index = furthest + 1;
  }
  return smoothed;
}

/** True when the straight segment remains inside rooms or their corridors. */
export function isWalkableLine(
  rects: readonly WorldRect[],
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  const distance = Math.hypot(toX - fromX, toY - fromY);
  const steps = Math.max(1, Math.ceil(distance / 12));
  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    if (!isWalkablePoint(
      rects,
      fromX + (toX - fromX) * progress,
      fromY + (toY - fromY) * progress,
    )) return false;
  }
  return true;
}

/**
 * Clamps a desired movement target onto the walkable surface, preferring to
 * slide along walls/corridor edges (axis-separated resolution).
 */
export function resolveWalkablePoint(
  rects: readonly WorldRect[],
  desiredX: number,
  desiredY: number,
  previousX: number,
  previousY: number,
): Readonly<{ x: number; y: number }> {
  const deltaX = desiredX - previousX;
  const deltaY = desiredY - previousY;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / 16));
  const stepX = deltaX / steps;
  const stepY = deltaY / steps;
  let resolvedX = previousX;
  let resolvedY = previousY;
  for (let step = 0; step < steps; step += 1) {
    const diagonalX = resolvedX + stepX;
    const diagonalY = resolvedY + stepY;
    if (isWalkablePoint(rects, diagonalX, diagonalY)) {
      resolvedX = diagonalX;
      resolvedY = diagonalY;
      continue;
    }
    // Resolve both axes in the same sub-step. The previous implementation
    // accepted only one candidate, dropping half of diagonal input at door
    // edges and causing visible hesitation/correction while entering corridors.
    let moved = false;
    if (isWalkablePoint(rects, diagonalX, resolvedY)) {
      resolvedX = diagonalX;
      moved = true;
    }
    if (isWalkablePoint(rects, resolvedX, diagonalY)) {
      resolvedY = diagonalY;
      moved = true;
    }
    if (!moved) break;
  }
  return { x: resolvedX, y: resolvedY };
}

/** Swept movement for circular actors, so their visible body cannot overlap a wall. */
export function resolveWalkableDiscPoint(
  rects: readonly WorldRect[],
  desiredX: number,
  desiredY: number,
  previousX: number,
  previousY: number,
  radius: number,
): Readonly<{ x: number; y: number }> {
  const walkable = (x: number, y: number): boolean => isWalkableDiscPoint(rects, x, y, radius);
  const deltaX = desiredX - previousX;
  const deltaY = desiredY - previousY;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / 8));
  const stepX = deltaX / steps;
  const stepY = deltaY / steps;
  let x = previousX;
  let y = previousY;
  for (let step = 0; step < steps; step += 1) {
    const nextX = x + stepX;
    const nextY = y + stepY;
    if (walkable(nextX, nextY)) { x = nextX; y = nextY; continue; }
    let moved = false;
    if (walkable(nextX, y)) { x = nextX; moved = true; }
    if (walkable(x, nextY)) { y = nextY; moved = true; }
    if (!moved) break;
  }
  return { x, y };
}

/** Exact spatially-indexed equivalent of resolveWalkableDiscPoint. */
export function resolveWalkableDiscPointIndexed(
  index: WalkableSpatialIndex,
  desiredX: number,
  desiredY: number,
  previousX: number,
  previousY: number,
  radius: number,
): Readonly<{ x: number; y: number }> {
  const walkable = (x: number, y: number): boolean => isWalkableDiscPointIndexed(index, x, y, radius);
  const deltaX = desiredX - previousX;
  const deltaY = desiredY - previousY;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / 8));
  const stepX = deltaX / steps;
  const stepY = deltaY / steps;
  let x = previousX;
  let y = previousY;
  for (let step = 0; step < steps; step += 1) {
    const nextX = x + stepX;
    const nextY = y + stepY;
    if (walkable(nextX, nextY)) { x = nextX; y = nextY; continue; }
    let moved = false;
    if (walkable(nextX, y)) { x = nextX; moved = true; }
    if (walkable(x, nextY)) { y = nextY; moved = true; }
    if (!moved) break;
  }
  return { x, y };
}

/** Corridor rectangles joining every orthogonally connected room pair. */
export function corridorRectsBetween(rooms: Iterable<GridRoomLike>): WorldRect[] {
  const grid = new Map<string, GridPosition>();
  for (const room of rooms) grid.set(room.id, { x: room.gridX, y: room.gridY });
  const rects: WorldRect[] = [];
  for (const room of rooms) {
    for (const connection of room.connections) {
      if (room.id.localeCompare(connection) >= 0) continue;
      const other = grid.get(connection);
      if (other) {
        const rect = corridorRectBetween({ x: room.gridX, y: room.gridY }, other);
        if (rect) rects.push(rect);
      }
    }
  }
  return rects;
}

/** Bounding box covering a set of world rects. */
export function boundsOf(rects: Iterable<WorldRect>): WorldRect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The grid room whose rectangle contains the world point, if any. */
export function roomContainingPoint(
  rooms: ReadonlyMap<string, GridPosition>,
  x: number,
  y: number,
): string | null {
  for (const [roomId, position] of rooms) {
    if (pointInRect(x, y, roomWorldRect(position))) return roomId;
  }
  return null;
}

type GridRoomLike = Readonly<{
  id: string;
  gridX: number;
  gridY: number;
  connections: readonly string[];
}>;

/**
 * Builds the walkable rect list + grid lookup from a set of grid rooms,
 * adding the boss arena when requested. Shared by server simulation and client.
 */
export function buildWorldFromRooms(
  rooms: Iterable<GridRoomLike>,
  includeBoss: boolean,
): { rects: WorldRect[]; grid: Map<string, GridPosition>; bossRect: WorldRect } {
  const grid = new Map<string, GridPosition>();
  for (const room of rooms) grid.set(room.id, { x: room.gridX, y: room.gridY });
  const corridors: Array<readonly [GridPosition, GridPosition]> = [];
  for (const room of rooms) {
    for (const connection of room.connections) {
      if (room.id.localeCompare(connection) >= 0) continue;
      const other = grid.get(connection);
      if (other) corridors.push([{ x: room.gridX, y: room.gridY }, other]);
    }
  }
  const rects = rectsFromRooms(grid, corridors);
  const bossRect = bossWorldRect();
  if (includeBoss) rects.push(bossRect);
  return { rects, grid, bossRect };
}

/** Parses a `zone-N:x,y` room id back into grid coordinates. */
export function roomIdToGrid(roomId: string): GridPosition | null {
  const match = /^zone-\d+:(-?\d+),(-?\d+)$/.exec(roomId);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]) };
}
