import { PLAYER_VISION_RADIUS, type MiniMapBounds, type MiniMapGeometry, type MiniMapSurface } from "@five-days/protocol";
import type { WorldRect } from "./world";
import { computeVisibilityPolygon, createWallSpatialIndex, pointInVisibilityPolygon, type WallSpatialIndex } from "./visibility";

export const MINIMAP_DEFAULT_CELL_SIZE = 32;
export const MINIMAP_MAX_AXIS_CELLS = 256;
export const MINIMAP_VISION_RADIUS: typeof PLAYER_VISION_RADIUS = PLAYER_VISION_RADIUS;
const walkableCellCache = new WeakMap<object, readonly number[]>();

export function rectToMiniMapSurface(rect: WorldRect, id: string): MiniMapSurface {
  return { id, points: [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ] };
}

export function createMiniMapGrid(bounds: MiniMapBounds): Pick<MiniMapGeometry, "cellSize" | "columns" | "rows"> {
  const cellSize = Math.max(
    MINIMAP_DEFAULT_CELL_SIZE,
    Math.ceil(bounds.width / MINIMAP_MAX_AXIS_CELLS),
    Math.ceil(bounds.height / MINIMAP_MAX_AXIS_CELLS),
  );
  return {
    cellSize,
    columns: Math.max(1, Math.ceil(bounds.width / cellSize)),
    rows: Math.max(1, Math.ceil(bounds.height / cellSize)),
  };
}

export function createExplorationMask(geometry: Pick<MiniMapGeometry, "columns" | "rows">): Uint8Array {
  return new Uint8Array(Math.ceil(geometry.columns * geometry.rows / 8));
}

export function isExplored(mask: Uint8Array, index: number): boolean {
  return index >= 0 && index < mask.length * 8 && (mask[index >> 3] & (1 << (index & 7))) !== 0;
}

export function revealCell(mask: Uint8Array, index: number): boolean {
  if (index < 0 || index >= mask.length * 8 || isExplored(mask, index)) return false;
  mask[index >> 3] |= 1 << (index & 7);
  return true;
}

export function cellIndexAt(geometry: MiniMapGeometry, x: number, y: number): number {
  const column = Math.floor((x - geometry.bounds.x) / geometry.cellSize);
  const row = Math.floor((y - geometry.bounds.y) / geometry.cellSize);
  if (column < 0 || row < 0 || column >= geometry.columns || row >= geometry.rows) return -1;
  return row * geometry.columns + column;
}

export function cellCenter(geometry: MiniMapGeometry, index: number): { x: number; y: number } {
  const column = index % geometry.columns;
  const row = Math.floor(index / geometry.columns);
  return {
    x: geometry.bounds.x + (column + 0.5) * geometry.cellSize,
    y: geometry.bounds.y + (row + 0.5) * geometry.cellSize,
  };
}

export function pointInMiniMapSurfaces(surfaces: readonly MiniMapSurface[], x: number, y: number): boolean {
  return surfaces.some((surface) => pointInPolygon(surface.points, x, y));
}

export function revealAround(
  geometry: MiniMapGeometry,
  mask: Uint8Array,
  x: number,
  y: number,
  radius: number = MINIMAP_VISION_RADIUS,
  wallIndex?: WallSpatialIndex,
): number[] {
  const polygon = computeVisibilityPolygon(
    { x, y },
    radius,
    wallIndex ?? createWallSpatialIndex(geometry.wallSegments),
  );
  return revealVisibilityPolygon(geometry, mask, polygon, x, y, radius);
}

export function revealVisibilityPolygon(
  geometry: MiniMapGeometry,
  mask: Uint8Array,
  polygon: readonly Readonly<{ x: number; y: number }>[],
  x: number,
  y: number,
  radius: number = geometry.visionRadius,
): number[] {
  const minColumn = Math.max(0, Math.floor((x - radius - geometry.bounds.x) / geometry.cellSize));
  const maxColumn = Math.min(geometry.columns - 1, Math.floor((x + radius - geometry.bounds.x) / geometry.cellSize));
  const minRow = Math.max(0, Math.floor((y - radius - geometry.bounds.y) / geometry.cellSize));
  const maxRow = Math.min(geometry.rows - 1, Math.floor((y + radius - geometry.bounds.y) / geometry.cellSize));
  const revealed: number[] = [];
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const index = row * geometry.columns + column;
      const center = cellCenter(geometry, index);
      if (Math.hypot(center.x - x, center.y - y) > radius) continue;
      const half = geometry.cellSize * 0.48;
      const samples = [
        center,
        { x: center.x - half, y: center.y - half },
        { x: center.x + half, y: center.y - half },
        { x: center.x + half, y: center.y + half },
        { x: center.x - half, y: center.y + half },
      ];
      if (!samples.every((sample) => pointInVisibilityPolygon(polygon, sample.x, sample.y))) continue;
      if (!samples.every((sample) => pointInMiniMapSurfaces(geometry.surfaces, sample.x, sample.y))) continue;
      if (revealCell(mask, index)) revealed.push(index);
    }
  }
  return revealed;
}

export function encodeMask(mask: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(mask).toString("base64");
  let binary = "";
  for (const byte of mask) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeMask(encoded: string, expectedBytes: number): Uint8Array {
  const bytes = typeof Buffer !== "undefined"
    ? new Uint8Array(Buffer.from(encoded, "base64"))
    : Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  if (bytes.byteLength !== expectedBytes) throw new Error("INVALID_MINIMAP_MASK_SIZE");
  return bytes;
}

export function encodeCellRanges(indices: Iterable<number>): Array<[number, number]> {
  const sorted = [...new Set(indices)].sort((left, right) => left - right);
  const ranges: Array<[number, number]> = [];
  for (const index of sorted) {
    const previous = ranges.at(-1);
    if (previous && previous[0] + previous[1] === index) previous[1] += 1;
    else ranges.push([index, 1]);
  }
  return ranges;
}

export function applyCellRanges(mask: Uint8Array, ranges: readonly (readonly [number, number])[], cellCount: number): boolean {
  for (const [start, length] of ranges) {
    if (start < 0 || length <= 0 || start + length > cellCount) return false;
    for (let index = start; index < start + length; index += 1) revealCell(mask, index);
  }
  return true;
}

export function explorationPercent(geometry: MiniMapGeometry, mask: Uint8Array): number {
  let explored = 0;
  const walkable = walkableCellIndices(geometry);
  for (const index of walkable) {
    if (isExplored(mask, index)) explored += 1;
  }
  return walkable.length === 0 ? 0 : Math.min(100, explored / walkable.length * 100);
}

export function walkableCellIndices(geometry: MiniMapGeometry): readonly number[] {
  const cached = walkableCellCache.get(geometry);
  if (cached) return cached;
  const result: number[] = [];
  for (let index = 0; index < geometry.columns * geometry.rows; index += 1) {
    const center = cellCenter(geometry, index);
    if (pointInMiniMapSurfaces(geometry.surfaces, center.x, center.y)) result.push(index);
  }
  walkableCellCache.set(geometry, result);
  return result;
}

function pointInPolygon(points: readonly { x: number; y: number }[], x: number, y: number): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index];
    const b = points[previous];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
