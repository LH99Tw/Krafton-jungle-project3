import type {
  EditorConnectionPort,
  EditorMapDefinition,
  EditorRoom,
} from "./mapEditor";

export type EditorGeometryPoint = { x: number; y: number };
export type EditorGeometryRect = { x: number; y: number; width: number; height: number };
export type EditorWallSegment = { x1: number; y1: number; x2: number; y2: number };

export type EditorRouteGeometry = {
  connectionId: string;
  points: EditorGeometryPoint[];
  floorRects: EditorGeometryRect[];
  length: number;
  bends: number;
};

export type EditorMapGeometry = {
  roomRects: Map<string, EditorGeometryRect>;
  routes: EditorRouteGeometry[];
  floorRects: EditorGeometryRect[];
  wallSegments: EditorWallSegment[];
  errors: string[];
};

export type EditorGeometryScale = {
  cellWidth: number;
  cellHeight: number;
  corridorWidth: number;
};

const DIRECTIONS = [
  { dx: 1, dy: 0, id: "e" },
  { dx: 0, dy: 1, id: "s" },
  { dx: -1, dy: 0, id: "w" },
  { dx: 0, dy: -1, id: "n" },
] as const;

type GridPoint = { x: number; y: number };
export type EditorRoomPortGeometry = {
  port: EditorConnectionPort;
  outside: GridPoint;
  door: EditorGeometryPoint;
};
type Port = EditorRoomPortGeometry;
type SearchNode = GridPoint & { direction: string; cost: number; estimate: number; previous: string | null };

/** Builds the single source of truth used by both the SVG editor and Phaser playtest. */
export function buildEditorGeometry(map: EditorMapDefinition, scale: EditorGeometryScale): EditorMapGeometry {
  const errors: string[] = [];
  const roomRects = new Map(map.rooms.map((room) => [room.id, scaledRoomRect(room, scale)]));
  for (let left = 0; left < map.rooms.length; left += 1) {
    for (let right = left + 1; right < map.rooms.length; right += 1) {
      if (roomsOverlap(map.rooms[left]!, map.rooms[right]!)) {
        errors.push(`방 “${map.rooms[left]!.name}”과 “${map.rooms[right]!.name}”이 겹칩니다.`);
      } else if (roomsShareEdge(map.rooms[left]!, map.rooms[right]!)) {
        errors.push(`방 “${map.rooms[left]!.name}”과 “${map.rooms[right]!.name}” 사이에 통로용 한 칸을 비워 주세요.`);
      }
    }
  }

  const occupied = occupiedRoomCells(map.rooms);
  const usedRouteCells = new Set<string>();
  const routes: EditorRouteGeometry[] = [];
  const connections = [...map.connections].sort((left, right) => left.id.localeCompare(right.id));
  for (const connection of connections) {
    const from = map.rooms.find((room) => room.id === connection.from);
    const to = map.rooms.find((room) => room.id === connection.to);
    if (!from || !to || from.id === to.id) continue;
    const routed = routeConnection(
      from,
      to,
      map.rooms,
      occupied,
      usedRouteCells,
      connection.fromPort,
      connection.toPort,
    );
    if (!routed) {
      errors.push(`“${from.name}”과 “${to.name}” 사이에 직교 통로를 만들 공간이 없습니다.`);
      continue;
    }
    for (const cell of routed.cells) usedRouteCells.add(cellKey(cell.x, cell.y));
    const points = compressPoints(routed.points).map((point) => ({ x: point.x * scale.cellWidth, y: point.y * scale.cellHeight }));
    const floorRects = routeFloorRects(points, scale.corridorWidth);
    routes.push({
      connectionId: connection.id,
      points,
      floorRects,
      length: polylineLength(points),
      bends: Math.max(0, points.length - 2),
    });
  }
  const floorRects = [...roomRects.values(), ...routes.flatMap((route) => route.floorRects)];
  return { roomRects, routes, floorRects, wallSegments: boundarySegments(floorRects), errors: unique(errors) };
}

function routeConnection(
  from: EditorRoom,
  to: EditorRoom,
  rooms: readonly EditorRoom[],
  occupied: ReadonlySet<string>,
  usedRouteCells: ReadonlySet<string>,
  fromPort?: EditorConnectionPort,
  toPort?: EditorConnectionPort,
): { points: EditorGeometryPoint[]; cells: GridPoint[] } | null {
  const bounds = routingBounds(rooms);
  let best: { points: EditorGeometryPoint[]; cells: GridPoint[]; score: number } | null = null;
  const starts = fromPort ? [editorRoomPort(from, fromPort)].filter(Boolean) as Port[] : legacyRoomPorts(from);
  const ends = toPort ? [editorRoomPort(to, toPort)].filter(Boolean) as Port[] : legacyRoomPorts(to);
  for (const start of starts) {
    for (const end of ends) {
      if (occupied.has(cellKey(start.outside.x, start.outside.y)) || occupied.has(cellKey(end.outside.x, end.outside.y))) continue;
      const cells = findGridPath(start.outside, end.outside, bounds, occupied, usedRouteCells);
      if (!cells) continue;
      const points = [start.door, ...cells.map(cellCenter), end.door];
      const score = cells.length * 10 + countBends(points) * 4;
      if (!best || score < best.score || (score === best.score && routeSignature(points) < routeSignature(best.points))) {
        best = { points, cells, score };
      }
    }
  }
  return best;
}

function findGridPath(
  start: GridPoint,
  end: GridPoint,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  occupied: ReadonlySet<string>,
  used: ReadonlySet<string>,
): GridPoint[] | null {
  const open: SearchNode[] = [{ ...start, direction: "", cost: 0, estimate: manhattan(start, end) * 10, previous: null }];
  const nodes = new Map<string, SearchNode>();
  nodes.set(searchKey(start.x, start.y, ""), open[0]!);
  const bestCost = new Map<string, number>();
  while (open.length > 0) {
    open.sort((left, right) => left.estimate - right.estimate || left.cost - right.cost || searchKey(left.x, left.y, left.direction).localeCompare(searchKey(right.x, right.y, right.direction)));
    const current = open.shift()!;
    if (current.x === end.x && current.y === end.y) return reconstructPath(current, nodes);
    for (const direction of DIRECTIONS) {
      const x = current.x + direction.dx;
      const y = current.y + direction.dy;
      if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) continue;
      const positionKey = cellKey(x, y);
      const isEndpoint = x === end.x && y === end.y;
      if (!isEndpoint && (occupied.has(positionKey) || used.has(positionKey))) continue;
      const cost = current.cost + 10 + (current.direction && current.direction !== direction.id ? 4 : 0);
      const stateKey = searchKey(x, y, direction.id);
      if (cost >= (bestCost.get(stateKey) ?? Number.POSITIVE_INFINITY)) continue;
      bestCost.set(stateKey, cost);
      const node: SearchNode = {
        x, y, direction: direction.id, cost,
        estimate: cost + manhattan({ x, y }, end) * 10,
        previous: searchKey(current.x, current.y, current.direction),
      };
      nodes.set(stateKey, node);
      open.push(node);
    }
  }
  return null;
}

function reconstructPath(last: SearchNode, nodes: ReadonlyMap<string, SearchNode>): GridPoint[] {
  const result: GridPoint[] = [];
  let current: SearchNode | undefined = last;
  while (current) {
    result.push({ x: current.x, y: current.y });
    current = current.previous ? nodes.get(current.previous) : undefined;
  }
  return result.reverse();
}

/** Every selectable grid-aligned doorway on a room perimeter. */
export function editorRoomPorts(room: EditorRoom): EditorRoomPortGeometry[] {
  const result: EditorRoomPortGeometry[] = [];
  for (const side of ["north", "east", "south", "west"] as const) {
    const span = side === "north" || side === "south" ? room.width : room.height;
    for (let offset = 0; offset < span; offset += 1) {
      const geometry = editorRoomPort(room, { side, offset });
      if (geometry) result.push(geometry);
    }
  }
  return result;
}

/** Resolves one stored doorway into its door point and adjacent routing cell. */
export function editorRoomPort(room: EditorRoom, port: EditorConnectionPort): EditorRoomPortGeometry | null {
  const span = port.side === "north" || port.side === "south" ? room.width : room.height;
  if (!Number.isInteger(port.offset) || port.offset < 0 || port.offset >= span) return null;
  if (port.side === "north") return { port, outside: { x: room.x + port.offset, y: room.y - 1 }, door: { x: room.x + port.offset + 0.5, y: room.y } };
  if (port.side === "east") return { port, outside: { x: room.x + room.width, y: room.y + port.offset }, door: { x: room.x + room.width, y: room.y + port.offset + 0.5 } };
  if (port.side === "south") return { port, outside: { x: room.x + port.offset, y: room.y + room.height }, door: { x: room.x + port.offset + 0.5, y: room.y + room.height } };
  return { port, outside: { x: room.x - 1, y: room.y + port.offset }, door: { x: room.x, y: room.y + port.offset + 0.5 } };
}

function legacyRoomPorts(room: EditorRoom): Port[] {
  const column = room.x + Math.floor(room.width / 2);
  const row = room.y + Math.floor(room.height / 2);
  return [
    { port: { side: "north", offset: column - room.x }, outside: { x: column, y: room.y - 1 }, door: { x: column + 0.5, y: room.y } },
    { port: { side: "east", offset: row - room.y }, outside: { x: room.x + room.width, y: row }, door: { x: room.x + room.width, y: row + 0.5 } },
    { port: { side: "south", offset: column - room.x }, outside: { x: column, y: room.y + room.height }, door: { x: column + 0.5, y: room.y + room.height } },
    { port: { side: "west", offset: row - room.y }, outside: { x: room.x - 1, y: row }, door: { x: room.x, y: row + 0.5 } },
  ];
}

function routeFloorRects(points: readonly EditorGeometryPoint[], width: number): EditorGeometryRect[] {
  const half = width / 2;
  const rects: EditorGeometryRect[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    if (from.x === to.x) rects.push({ x: from.x - half, y: Math.min(from.y, to.y) - half, width, height: Math.abs(to.y - from.y) + width });
    else if (from.y === to.y) rects.push({ x: Math.min(from.x, to.x) - half, y: from.y - half, width: Math.abs(to.x - from.x) + width, height: width });
  }
  return rects;
}

/** Returns only the outside boundary of the union of axis-aligned floor rectangles. */
export function boundarySegments(rects: readonly EditorGeometryRect[]): EditorWallSegment[] {
  const segments: EditorWallSegment[] = [];
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
  return mergeWallSegments(segments);
}

function mergeWallSegments(segments: readonly EditorWallSegment[]): EditorWallSegment[] {
  const sorted = [...segments].sort((left, right) => left.y1 - right.y1 || left.x1 - right.x1 || left.y2 - right.y2 || left.x2 - right.x2);
  const merged: EditorWallSegment[] = [];
  for (const segment of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.y1 === previous.y2 && segment.y1 === segment.y2 && previous.y1 === segment.y1 && Math.abs(previous.x2 - segment.x1) < 0.01) previous.x2 = segment.x2;
    else if (previous && previous.x1 === previous.x2 && segment.x1 === segment.x2 && previous.x1 === segment.x1 && Math.abs(previous.y2 - segment.y1) < 0.01) previous.y2 = segment.y2;
    else merged.push({ ...segment });
  }
  return merged;
}

function compressPoints(points: readonly EditorGeometryPoint[]): EditorGeometryPoint[] {
  const result: EditorGeometryPoint[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    const before = result.at(-2);
    if (before && previous && ((before.x === previous.x && previous.x === point.x) || (before.y === previous.y && previous.y === point.y))) result[result.length - 1] = point;
    else result.push(point);
  }
  return result;
}

function scaledRoomRect(room: EditorRoom, scale: EditorGeometryScale): EditorGeometryRect {
  return { x: room.x * scale.cellWidth, y: room.y * scale.cellHeight, width: room.width * scale.cellWidth, height: room.height * scale.cellHeight };
}

function occupiedRoomCells(rooms: readonly EditorRoom[]): Set<string> {
  const result = new Set<string>();
  for (const room of rooms) for (let y = room.y; y < room.y + room.height; y += 1) for (let x = room.x; x < room.x + room.width; x += 1) result.add(cellKey(x, y));
  return result;
}

function routingBounds(rooms: readonly EditorRoom[]) {
  return {
    minX: Math.min(...rooms.map((room) => room.x)) - 4,
    minY: Math.min(...rooms.map((room) => room.y)) - 4,
    maxX: Math.max(...rooms.map((room) => room.x + room.width)) + 4,
    maxY: Math.max(...rooms.map((room) => room.y + room.height)) + 4,
  };
}

function roomsOverlap(left: EditorRoom, right: EditorRoom): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x && left.y < right.y + right.height && left.y + left.height > right.y;
}

function roomsShareEdge(left: EditorRoom, right: EditorRoom): boolean {
  const horizontalTouch = (left.x + left.width === right.x || right.x + right.width === left.x)
    && left.y < right.y + right.height && left.y + left.height > right.y;
  const verticalTouch = (left.y + left.height === right.y || right.y + right.height === left.y)
    && left.x < right.x + right.width && left.x + left.width > right.x;
  return horizontalTouch || verticalTouch;
}

function pointInRect(x: number, y: number, rect: EditorGeometryRect): boolean {
  return x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height;
}

function cellCenter(point: GridPoint): EditorGeometryPoint { return { x: point.x + 0.5, y: point.y + 0.5 }; }
function cellKey(x: number, y: number): string { return `${x}:${y}`; }
function searchKey(x: number, y: number, direction: string): string { return `${x}:${y}:${direction}`; }
function manhattan(left: GridPoint, right: GridPoint): number { return Math.abs(left.x - right.x) + Math.abs(left.y - right.y); }
function countBends(points: readonly EditorGeometryPoint[]): number { return Math.max(0, compressPoints(points).length - 2); }
function routeSignature(points: readonly EditorGeometryPoint[]): string { return points.map((point) => `${point.x},${point.y}`).join("|"); }
function polylineLength(points: readonly EditorGeometryPoint[]): number { return points.slice(1).reduce((total, point, index) => total + Math.abs(point.x - points[index]!.x) + Math.abs(point.y - points[index]!.y), 0); }
function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
