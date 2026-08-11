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
import { buildEditorGeometry, type EditorWallSegment } from "../../domain/editorGeometry";

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
  wallSegments: EditorWallSegment[];
  bounds: WorldRect;
  bossRect: WorldRect;
};

const EDITOR_CELL_WIDTH = 320;
const EDITOR_CELL_HEIGHT = 220;
const EDITOR_CORRIDOR_SIZE = 180;

export type EditorRenderableRoom = RenderableRoom & { width: number; height: number };

/** Builds one continuous, freely-sized world from rooms placed by the local map editor. */
export function buildEditorRenderWorld(rooms: readonly EditorRenderableRoom[]): RenderZoneWorld {
  const connections = new Map<string, { id: string; from: string; to: string }>();
  for (const room of rooms) for (const connectedId of room.connections) {
    const ids = [room.id, connectedId].sort();
    const id = `${ids[0]}|${ids[1]}`;
    connections.set(id, { id, from: ids[0]!, to: ids[1]! });
  }
  const geometry = buildEditorGeometry({
    version: 1,
    title: "runtime",
    rooms: rooms.map((room) => ({
      id: room.id, name: room.id, type: room.type === "central-waypoint" || room.type === "hidden-monster" ? "empty" : room.type,
      asset: room.zone === 2 ? "marsh" : room.zone === 3 ? "wastes" : "forest",
      x: room.x, y: room.y, width: room.width, height: room.height,
    })),
    connections: [...connections.values()],
  }, { cellWidth: EDITOR_CELL_WIDTH, cellHeight: EDITOR_CELL_HEIGHT, corridorWidth: EDITOR_CORRIDOR_SIZE });
  const contentBounds = boundsOf(geometry.floorRects);
  const offsetX = EDITOR_CELL_WIDTH - contentBounds.x;
  const offsetY = EDITOR_CELL_HEIGHT - contentBounds.y;
  const translateRect = (rect: WorldRect): WorldRect => ({ ...rect, x: rect.x + offsetX, y: rect.y + offsetY });
  const worldRooms = rooms.map((room): RenderWorldRoom => {
    const rect = translateRect(geometry.roomRects.get(room.id)!);
    return { room, rect, center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
  });
  const corridors = geometry.routes.flatMap((route) => route.floorRects.map(translateRect));
  const walkable = [...worldRooms.map((room) => room.rect), ...corridors];
  const translatedBounds = boundsOf(walkable);
  const bounds = {
    x: 0,
    y: 0,
    width: translatedBounds.x + translatedBounds.width + EDITOR_CELL_WIDTH,
    height: translatedBounds.y + translatedBounds.height + EDITOR_CELL_HEIGHT,
  };
  const bossRoom = worldRooms.find((room) => room.room.type === "boss");
  return {
    rooms: worldRooms,
    corridors,
    blockedCells: [],
    walkable,
    wallSegments: geometry.wallSegments.map((segment) => ({ x1: segment.x1 + offsetX, y1: segment.y1 + offsetY, x2: segment.x2 + offsetX, y2: segment.y2 + offsetY })),
    bounds,
    bossRect: bossRoom?.rect ?? { x: bounds.x, y: bounds.y, width: 1280, height: 720 },
  };
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
    wallSegments: [],
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
  radius = 0,
): { x: number; y: number } {
  if (radius <= 0) return resolveWalkablePoint(walkable, x, y, previousX, previousY);
  const deltaX = x - previousX;
  const deltaY = y - previousY;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / 8));
  let resolvedX = previousX;
  let resolvedY = previousY;
  const stepX = deltaX / steps;
  const stepY = deltaY / steps;
  for (let step = 0; step < steps; step += 1) {
    const nextX = resolvedX + stepX;
    const nextY = resolvedY + stepY;
    if (isWalkableDisc(walkable, nextX, nextY, radius)) { resolvedX = nextX; resolvedY = nextY; continue; }
    let moved = false;
    if (isWalkableDisc(walkable, nextX, resolvedY, radius)) { resolvedX = nextX; moved = true; }
    if (isWalkableDisc(walkable, resolvedX, nextY, radius)) { resolvedY = nextY; moved = true; }
    if (!moved) break;
  }
  return { x: resolvedX, y: resolvedY };
}

export function isWalkableDisc(walkable: readonly WorldRect[], x: number, y: number, radius = 0): boolean {
  const samples = radius > 0
    ? [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius], [radius * 0.7, radius * 0.7], [-radius * 0.7, radius * 0.7], [radius * 0.7, -radius * 0.7], [-radius * 0.7, -radius * 0.7]]
    : [[0, 0]];
  return samples.every(([offsetX, offsetY]) => walkable.some((rect) => x + offsetX! >= rect.x && x + offsetX! < rect.x + rect.width && y + offsetY! >= rect.y && y + offsetY! < rect.y + rect.height));
}

export function clipWalkableLine(walkable: readonly WorldRect[], fromX: number, fromY: number, toX: number, toY: number, radius = 0): { x: number; y: number; clear: boolean } {
  const distance = Math.hypot(toX - fromX, toY - fromY);
  const steps = Math.max(1, Math.ceil(distance / 8));
  let x = fromX;
  let y = fromY;
  for (let step = 1; step <= steps; step += 1) {
    const nextX = fromX + (toX - fromX) * step / steps;
    const nextY = fromY + (toY - fromY) * step / steps;
    if (!isWalkableDisc(walkable, nextX, nextY, radius)) return { x, y, clear: false };
    x = nextX; y = nextY;
  }
  return { x: toX, y: toY, clear: true };
}
