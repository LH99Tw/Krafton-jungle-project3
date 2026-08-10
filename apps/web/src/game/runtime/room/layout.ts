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
