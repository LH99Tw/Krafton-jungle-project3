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

/** True when the world point is on a walkable surface (room or corridor). */
function isWalkablePoint(rects: readonly WorldRect[], x: number, y: number): boolean {
  for (const rect of rects) if (pointInRect(x, y, rect)) return true;
  return false;
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
