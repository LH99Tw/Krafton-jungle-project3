import {
  boundsOf,
  buildWorldFromRooms,
  corridorRectsBetween,
  resolveWalkablePoint,
  roomWorldCenter,
  roomWorldRect,
  ZONE_GRID_SIZE,
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
  blockedCells: WorldRect[];
  walkable: WorldRect[];
  bounds: WorldRect;
  bossRect: WorldRect;
};

const EDITOR_CELL_WIDTH = 320;
const EDITOR_CELL_HEIGHT = 220;
const EDITOR_CORRIDOR_SIZE = 180;

export type EditorRenderableRoom = RenderableRoom & { width: number; height: number };

/** Builds one continuous, freely-sized world from rooms placed by the local map editor. */
export function buildEditorRenderWorld(rooms: readonly EditorRenderableRoom[]): RenderZoneWorld {
  const minX = Math.min(...rooms.map((room) => room.x));
  const minY = Math.min(...rooms.map((room) => room.y));
  const shifted = rooms.map((room) => ({ ...room, x: room.x - minX + 1, y: room.y - minY + 1 }));
  const roomById = new Map<string, RenderWorldRoom>();
  const worldRooms = shifted.map((room): RenderWorldRoom => {
    const rect = {
      x: room.x * EDITOR_CELL_WIDTH,
      y: room.y * EDITOR_CELL_HEIGHT,
      width: room.width * EDITOR_CELL_WIDTH,
      height: room.height * EDITOR_CELL_HEIGHT,
    };
    const entry = { room, rect, center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
    roomById.set(room.id, entry);
    return entry;
  });
  const corridors: WorldRect[] = [];
  const seen = new Set<string>();
  for (const room of shifted) {
    for (const connectedId of room.connections) {
      const edge = [room.id, connectedId].sort().join("|");
      if (seen.has(edge)) continue;
      seen.add(edge);
      const from = roomById.get(room.id);
      const to = roomById.get(connectedId);
      if (!from || !to) continue;
      const horizontalFirst = Math.abs(to.center.x - from.center.x) >= Math.abs(to.center.y - from.center.y);
      if (horizontalFirst) {
        corridors.push(horizontalCorridor(from.center.x, to.center.x, from.center.y));
        corridors.push(verticalCorridor(from.center.y, to.center.y, to.center.x));
      } else {
        corridors.push(verticalCorridor(from.center.y, to.center.y, from.center.x));
        corridors.push(horizontalCorridor(from.center.x, to.center.x, to.center.y));
      }
    }
  }
  const walkable = [...worldRooms.map((room) => room.rect), ...corridors];
  const contentBounds = boundsOf(walkable);
  const bounds = {
    x: 0,
    y: 0,
    width: contentBounds.x + contentBounds.width + EDITOR_CELL_WIDTH,
    height: contentBounds.y + contentBounds.height + EDITOR_CELL_HEIGHT,
  };
  const bossRoom = worldRooms.find((room) => room.room.type === "boss");
  return {
    rooms: worldRooms,
    corridors,
    blockedCells: [],
    walkable,
    bounds,
    bossRect: bossRoom?.rect ?? { x: bounds.x, y: bounds.y, width: 1280, height: 720 },
  };
}

function horizontalCorridor(fromX: number, toX: number, y: number): WorldRect {
  return { x: Math.min(fromX, toX), y: y - EDITOR_CORRIDOR_SIZE / 2, width: Math.max(EDITOR_CORRIDOR_SIZE, Math.abs(toX - fromX)), height: EDITOR_CORRIDOR_SIZE };
}

function verticalCorridor(fromY: number, toY: number, x: number): WorldRect {
  return { x: x - EDITOR_CORRIDOR_SIZE / 2, y: Math.min(fromY, toY), width: EDITOR_CORRIDOR_SIZE, height: Math.max(EDITOR_CORRIDOR_SIZE, Math.abs(toY - fromY)) };
}

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
  const occupied = new Set(rooms.map((room) => `${room.x},${room.y}`));
  const blockedCells: WorldRect[] = [];
  for (let y = 0; y < ZONE_GRID_SIZE; y += 1) {
    for (let x = 0; x < ZONE_GRID_SIZE; x += 1) {
      if (!occupied.has(`${x},${y}`)) blockedCells.push(roomWorldRect({ x, y }));
    }
  }
  return {
    rooms: worldRooms,
    corridors: corridorRectsBetween(like),
    blockedCells,
    walkable: built.rects,
    // Include blocked grid cells so the visual background covers the complete
    // field, not only the local bounding box of generated walkable rooms.
    bounds: boundsOf([...built.rects, ...blockedCells]),
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
