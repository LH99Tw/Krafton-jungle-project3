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
  doorHalfSize: 64,
} as const;

export const BASE_CORE = { x: 220, y: 535 } as const;

export const BUILD_BOUNDS = {
  minX: 82,
  maxX: 486,
  minY: 390,
  maxY: 638,
  gridSize: 40,
} as const;

export type DoorDirection = "north" | "east" | "south" | "west";

export type DoorLayout = {
  direction: DoorDirection;
  destinationId: string;
  x: number;
  y: number;
  spawnX: number;
  spawnY: number;
};

export type RenderableRoom = {
  id: string;
  zone: number;
  x: number;
  y: number;
  type: "start" | "gate" | "resource" | "static-monster" | "empty" | "central-waypoint" | "hidden-monster" | "boss";
  connections: readonly string[];
};

export function doorLayouts(room: RenderableRoom, rooms: readonly RenderableRoom[]): DoorLayout[] {
  const byId = new Map(rooms.map((candidate) => [candidate.id, candidate]));
  return room.connections.flatMap((destinationId) => {
    const destination = byId.get(destinationId) ?? roomCoordinatesFromId(destinationId);
    if (!destination) return [];
    const direction = directionBetween(room, destination);
    if (!direction) return [];
    return [{ ...doorPosition(direction), direction, destinationId }];
  });
}

function roomCoordinatesFromId(roomId: string): Pick<RenderableRoom, "x" | "y"> | null {
  const match = /^zone-\d+:(-?\d+),(-?\d+)$/.exec(roomId);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]) };
}

export function directionBetween(
  from: Pick<RenderableRoom, "x" | "y">,
  to: Pick<RenderableRoom, "x" | "y">,
): DoorDirection | null {
  if (to.x === from.x && to.y === from.y - 1) return "north";
  if (to.x === from.x + 1 && to.y === from.y) return "east";
  if (to.x === from.x && to.y === from.y + 1) return "south";
  if (to.x === from.x - 1 && to.y === from.y) return "west";
  return null;
}

export function oppositeDirection(direction: DoorDirection): DoorDirection {
  if (direction === "north") return "south";
  if (direction === "south") return "north";
  if (direction === "east") return "west";
  return "east";
}

export function doorPosition(direction: DoorDirection): Omit<DoorLayout, "direction" | "destinationId"> {
  if (direction === "north") {
    return { x: ROOM_VIEW.width / 2, y: ROOM_VIEW.top, spawnX: ROOM_VIEW.width / 2, spawnY: ROOM_VIEW.top + 78 };
  }
  if (direction === "south") {
    return { x: ROOM_VIEW.width / 2, y: ROOM_VIEW.bottom, spawnX: ROOM_VIEW.width / 2, spawnY: ROOM_VIEW.bottom - 78 };
  }
  if (direction === "east") {
    return { x: ROOM_VIEW.right, y: ROOM_VIEW.height / 2, spawnX: ROOM_VIEW.right - 78, spawnY: ROOM_VIEW.height / 2 };
  }
  return { x: ROOM_VIEW.left, y: ROOM_VIEW.height / 2, spawnX: ROOM_VIEW.left + 78, spawnY: ROOM_VIEW.height / 2 };
}

export function isInsideBuildBounds(x: number, y: number): boolean {
  return x >= BUILD_BOUNDS.minX && x <= BUILD_BOUNDS.maxX && y >= BUILD_BOUNDS.minY && y <= BUILD_BOUNDS.maxY;
}

export function snapToBuildGrid(value: number): number {
  return Math.round(value / BUILD_BOUNDS.gridSize) * BUILD_BOUNDS.gridSize;
}

export function clampToRoom(x: number, y: number, padding = 18): { x: number; y: number } {
  return {
    x: Math.max(ROOM_VIEW.left + padding, Math.min(ROOM_VIEW.right - padding, x)),
    y: Math.max(ROOM_VIEW.top + padding, Math.min(ROOM_VIEW.bottom - padding, y)),
  };
}

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
