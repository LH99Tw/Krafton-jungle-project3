import {
  boundsOf,
  buildWorldFromRooms,
  corridorRectsBetween,
  resolveWalkablePoint,
  roomWorldCenter,
  roomWorldRect,
  type WorldRect,
} from "@five-days/game-core";

export const ROOM_VIEW = {
  width: 1280,
  height: 720,
  left: 54,
  right: 1226,
  top: 52,
  bottom: 668,
} as const;

export const BASE_CORE = { x: 220, y: 535 } as const;

export const BUILD_BOUNDS = {
  minX: 82,
  maxX: 486,
  minY: 390,
  maxY: 638,
  gridSize: 40,
} as const;

export type RenderableRoom = {
  id: string;
  zone: number;
  x: number;
  y: number;
  type: "start" | "gate" | "resource" | "static-monster" | "empty" | "central-waypoint" | "hidden-monster" | "boss";
  connections: readonly string[];
};

export type RenderWorldRoom = {
  room: RenderableRoom;
  rect: WorldRect;
  center: { x: number; y: number };
};

export type RenderZoneWorld = {
  rooms: RenderWorldRoom[];
  corridors: WorldRect[];
  walkable: WorldRect[];
  bounds: WorldRect;
  bossRect: WorldRect;
};

/** True when `x,y` fall inside the base-camp build plot. */
export function isInsideBuildBounds(x: number, y: number): boolean {
  return x >= BUILD_BOUNDS.minX && x <= BUILD_BOUNDS.maxX && y >= BUILD_BOUNDS.minY && y <= BUILD_BOUNDS.maxY;
}

/** Snaps a coordinate onto the build grid. */
export function snapToBuildGrid(value: number): number {
  return Math.round(value / BUILD_BOUNDS.gridSize) * BUILD_BOUNDS.gridSize;
}

/**
 * Lays the rooms of a zone out as a single continuous world: each room fills a
 * world rectangle and connected rooms are joined by walkable corridors (통로).
 */
export function buildRenderWorld(rooms: readonly RenderableRoom[], includeBoss: boolean): RenderZoneWorld {
  const like = rooms.map((room) => ({ id: room.id, gridX: room.x, gridY: room.y, connections: room.connections }));
  const built = buildWorldFromRooms(like, includeBoss);
  const worldRooms: RenderWorldRoom[] = rooms.map((room) => {
    const rect = roomWorldRect({ x: room.x, y: room.y });
    return { room, rect, center: roomWorldCenter({ x: room.x, y: room.y }) };
  });
  return {
    rooms: worldRooms,
    corridors: corridorRectsBetween(like),
    walkable: built.rects,
    bounds: boundsOf(built.rects),
    bossRect: built.bossRect,
  };
}

/** Clamps a point to the outer world bounds (safety net for entity positions). */
export function clampToWorld(bounds: WorldRect, x: number, y: number, padding = 20): { x: number; y: number } {
  return {
    x: Math.max(bounds.x + padding, Math.min(bounds.x + bounds.width - padding, x)),
    y: Math.max(bounds.y + padding, Math.min(bounds.y + bounds.height - padding, y)),
  };
}

/**
 * Keeps a point on the walkable surface (rooms + corridors). Prevents the
 * player/enemies from walking through walls — only adjacent corridors are
 * passable, matching the server's authoritative movement.
 */
export function clampToWalkable(
  walkable: readonly WorldRect[],
  x: number,
  y: number,
  previousX: number,
  previousY: number,
): { x: number; y: number } {
  return resolveWalkablePoint(walkable, x, y, previousX, previousY);
}
