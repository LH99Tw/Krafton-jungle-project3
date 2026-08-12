import type {
  EditorConnection,
  EditorConnectionPort,
  EditorMapDefinition,
  EditorRoom,
} from "./mapEditor";
import { editorConnectionWidth, editorRoomJoins } from "./mapEditor";

type EditorGeometryPoint = { x: number; y: number };
export type EditorGeometryRect = { x: number; y: number; width: number; height: number };
export type EditorWallSegment = { x1: number; y1: number; x2: number; y2: number };

export type EditorRouteGeometry = {
  connectionId: string;
  width: number;
  points: EditorGeometryPoint[];
  floorRects: EditorGeometryRect[];
  length: number;
  bends: number;
  /** Grid cells reserved by this route, retained for incremental editor routing. */
  cells: GridPoint[];
};

export type EditorJoinGeometry = {
  connectionId: string;
  from: string;
  to: string;
  axis: "horizontal" | "vertical";
  points: EditorGeometryPoint[];
  opening: EditorGeometryRect;
  length: number;
};

export type EditorMapGeometry = {
  roomRects: Map<string, EditorGeometryRect>;
  routes: EditorRouteGeometry[];
  joins: EditorJoinGeometry[];
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
  { dx: 0.5, dy: 0, id: "e" },
  { dx: 0, dy: 0.5, id: "s" },
  { dx: -0.5, dy: 0, id: "w" },
  { dx: 0, dy: -0.5, id: "n" },
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
      }
    }
  }

  const joins = editorRoomJoins(map).map((join): EditorJoinGeometry => {
    const opening = join.axis === "vertical"
      ? { x: join.x * scale.cellWidth - scale.corridorWidth / 2, y: join.y * scale.cellHeight, width: scale.corridorWidth, height: join.length * scale.cellHeight }
      : { x: join.x * scale.cellWidth, y: join.y * scale.cellHeight - scale.corridorWidth / 2, width: join.length * scale.cellWidth, height: scale.corridorWidth };
    return {
      connectionId: join.connectionId,
      from: join.from,
      to: join.to,
      axis: join.axis,
      opening,
      points: [{ x: opening.x + opening.width / 2, y: opening.y + opening.height / 2 }],
      length: join.length,
    };
  });
  const joinedConnectionIds = new Set(joins.map((join) => join.connectionId));
  const usedRouteRects: EditorGeometryRect[] = [];
  const routes: EditorRouteGeometry[] = [];
  // Stored order is the routing priority. Appending a connection can therefore
  // be previewed incrementally without invalidating every established route.
  for (const connection of map.connections) {
    if (joinedConnectionIds.has(connection.id)) continue;
    const from = map.rooms.find((room) => room.id === connection.from);
    const to = map.rooms.find((room) => room.id === connection.to);
    if (!from || !to || from.id === to.id) continue;
    const width = editorConnectionWidth(connection);
    const routed = routeConnection(
      from,
      to,
      map.rooms,
      usedRouteRects,
      connection.fromPort,
      connection.toPort,
      width,
    );
    if (!routed) {
      errors.push(`“${from.name}”과 “${to.name}” 사이에 직교 통로를 만들 공간이 없습니다.`);
      continue;
    }
    usedRouteRects.push(...routeFloorRectsLogical(routed.points, width));
    const points = compressPoints(routed.points).map((point) => ({ x: point.x * scale.cellWidth, y: point.y * scale.cellHeight }));
    const floorRects = routeFloorRects(points, scale, width);
    routes.push({
      connectionId: connection.id,
      width,
      points,
      floorRects,
      length: polylineLength(points),
      bends: Math.max(0, points.length - 2),
      cells: routed.cells,
    });
  }
  const floorRects = [...roomRects.values(), ...routes.flatMap((route) => route.floorRects)];
  return { roomRects, routes, joins, floorRects, wallSegments: boundarySegments(floorRects), errors: unique(errors) };
}

/** Routes one new or edited connection without rebuilding existing routes or walls. */
export function buildEditorConnectionRoute(
  map: EditorMapDefinition,
  connection: EditorConnection,
  scale: EditorGeometryScale,
  existingGeometry: EditorMapGeometry,
): EditorRouteGeometry | null {
  const from = map.rooms.find((room) => room.id === connection.from);
  const to = map.rooms.find((room) => room.id === connection.to);
  if (!from || !to || from.id === to.id) return null;
  if (editorRoomJoins(map).some((join) => join.connectionId === connection.id)) return null;
  const usedRouteRects: EditorGeometryRect[] = [];
  for (const route of existingGeometry.routes) {
    if (route.connectionId === connection.id) continue;
    const logicalPoints = route.points.map((point) => ({ x: point.x / scale.cellWidth, y: point.y / scale.cellHeight }));
    usedRouteRects.push(...routeFloorRectsLogical(logicalPoints, route.width));
  }
  const width = editorConnectionWidth(connection);
  const routed = routeConnection(
    from,
    to,
    map.rooms,
    usedRouteRects,
    connection.fromPort,
    connection.toPort,
    width,
  );
  if (!routed) return null;
  const points = compressPoints(routed.points).map((point) => ({
    x: point.x * scale.cellWidth,
    y: point.y * scale.cellHeight,
  }));
  return {
    connectionId: connection.id,
    width,
    points,
    floorRects: routeFloorRects(points, scale, width),
    length: polylineLength(points),
    bends: Math.max(0, points.length - 2),
    cells: routed.cells,
  };
}

function routeConnection(
  from: EditorRoom,
  to: EditorRoom,
  rooms: readonly EditorRoom[],
  usedRouteRects: readonly EditorGeometryRect[],
  fromPort?: EditorConnectionPort,
  toPort?: EditorConnectionPort,
  width = 1,
): { points: EditorGeometryPoint[]; cells: GridPoint[] } | null {
  const bounds = routingBounds(rooms, width);
  let best: { points: EditorGeometryPoint[]; cells: GridPoint[]; score: number } | null = null;
  const starts = fromPort ? [editorRoomPort(from, fromPort, width)].filter(Boolean) as Port[] : legacyRoomPorts(from, width);
  const ends = toPort ? [editorRoomPort(to, toPort, width)].filter(Boolean) as Port[] : legacyRoomPorts(to, width);
  for (const start of starts) {
    for (const end of ends) {
      const cells = findGridPath(start.outside, end.outside, bounds, rooms, from.id, to.id, usedRouteRects, width);
      if (!cells) continue;
      const points = [start.door, ...cells, end.door];
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
  rooms: readonly EditorRoom[],
  fromId: string,
  toId: string,
  used: readonly EditorGeometryRect[],
  width: number,
): GridPoint[] | null {
  const open: SearchNode[] = [{ ...start, direction: "", cost: 0, estimate: manhattan(start, end) * 20, previous: null }];
  const nodes = new Map<string, SearchNode>();
  nodes.set(searchKey(start.x, start.y, ""), open[0]!);
  const bestCost = new Map<string, number>();
  while (open.length > 0) {
    const current = popSearchNode(open)!;
    if (current.x === end.x && current.y === end.y) return reconstructPath(current, nodes);
    for (const direction of DIRECTIONS) {
      const x = current.x + direction.dx;
      const y = current.y + direction.dy;
      if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) continue;
      const isEndpoint = x === end.x && y === end.y;
      const segment = logicalSegmentRect(current, { x, y }, width);
      if (routeStepBlocked(segment, { x, y }, rooms, fromId, toId, used, current.x === start.x && current.y === start.y, isEndpoint)) continue;
      const cost = current.cost + 10 + (current.direction && current.direction !== direction.id ? 4 : 0);
      const stateKey = searchKey(x, y, direction.id);
      if (cost >= (bestCost.get(stateKey) ?? Number.POSITIVE_INFINITY)) continue;
      bestCost.set(stateKey, cost);
      const node: SearchNode = {
        x, y, direction: direction.id, cost,
        estimate: cost + manhattan({ x, y }, end) * 20,
        previous: searchKey(current.x, current.y, current.direction),
      };
      nodes.set(stateKey, node);
      pushSearchNode(open, node);
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

function compareSearchNodes(left: SearchNode, right: SearchNode): number {
  return left.estimate - right.estimate
    || left.cost - right.cost
    || searchKey(left.x, left.y, left.direction).localeCompare(searchKey(right.x, right.y, right.direction));
}

function pushSearchNode(heap: SearchNode[], node: SearchNode): void {
  heap.push(node);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareSearchNodes(heap[parent]!, heap[index]!) <= 0) break;
    [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
    index = parent;
  }
}

function popSearchNode(heap: SearchNode[]): SearchNode | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (!first || !last || heap.length === 0) return first;
  heap[0] = last;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.length && compareSearchNodes(heap[left]!, heap[smallest]!) < 0) smallest = left;
    if (right < heap.length && compareSearchNodes(heap[right]!, heap[smallest]!) < 0) smallest = right;
    if (smallest === index) break;
    [heap[index], heap[smallest]] = [heap[smallest]!, heap[index]!];
    index = smallest;
  }
  return first;
}

/** Every selectable grid-aligned doorway on a room perimeter. */
export function editorRoomPorts(room: EditorRoom, width = 1): EditorRoomPortGeometry[] {
  const result: EditorRoomPortGeometry[] = [];
  for (const side of ["north", "east", "south", "west"] as const) {
    const span = side === "north" || side === "south" ? room.width : room.height;
    for (let offset = 0; offset + width <= span; offset += 1) {
      const geometry = editorRoomPort(room, { side, offset }, width);
      if (geometry) result.push(geometry);
    }
  }
  return result;
}

/** Resolves one stored doorway into its door point and adjacent routing cell. */
export function editorRoomPort(room: EditorRoom, port: EditorConnectionPort, width = 1): EditorRoomPortGeometry | null {
  const span = port.side === "north" || port.side === "south" ? room.width : room.height;
  if (!Number.isInteger(port.offset) || port.offset < 0 || port.offset + width > span) return null;
  const center = port.offset + width / 2;
  if (port.side === "north") return { port, outside: { x: room.x + center, y: room.y - 0.5 }, door: { x: room.x + center, y: room.y } };
  if (port.side === "east") return { port, outside: { x: room.x + room.width + 0.5, y: room.y + center }, door: { x: room.x + room.width, y: room.y + center } };
  if (port.side === "south") return { port, outside: { x: room.x + center, y: room.y + room.height + 0.5 }, door: { x: room.x + center, y: room.y + room.height } };
  return { port, outside: { x: room.x - 0.5, y: room.y + center }, door: { x: room.x, y: room.y + center } };
}

function legacyRoomPorts(room: EditorRoom, width = 1): Port[] {
  return (["north", "east", "south", "west"] as const).flatMap((side) => {
    const span = side === "north" || side === "south" ? room.width : room.height;
    if (width > span) return [];
    const port = editorRoomPort(room, { side, offset: Math.floor((span - width) / 2) }, width);
    return port ? [port] : [];
  });
}

function routeFloorRects(points: readonly EditorGeometryPoint[], scale: EditorGeometryScale, width: number): EditorGeometryRect[] {
  const rects: EditorGeometryRect[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    if (from.x === to.x) {
      const thickness = scale.corridorWidth + (width - 1) * scale.cellWidth;
      rects.push({ x: from.x - thickness / 2, y: Math.min(from.y, to.y) - scale.corridorWidth / 2, width: thickness, height: Math.abs(to.y - from.y) + scale.corridorWidth });
    } else if (from.y === to.y) {
      const thickness = scale.corridorWidth + (width - 1) * scale.cellHeight;
      rects.push({ x: Math.min(from.x, to.x) - scale.corridorWidth / 2, y: from.y - thickness / 2, width: Math.abs(to.x - from.x) + scale.corridorWidth, height: thickness });
    }
  }
  return rects;
}

function routeFloorRectsLogical(points: readonly EditorGeometryPoint[], width: number): EditorGeometryRect[] {
  const scale = { cellWidth: 1, cellHeight: 1, corridorWidth: 0.5 };
  return routeFloorRects(points, scale, width);
}

function logicalSegmentRect(from: EditorGeometryPoint, to: EditorGeometryPoint, width: number): EditorGeometryRect {
  return routeFloorRectsLogical([from, to], width)[0] ?? { x: to.x, y: to.y, width: 0, height: 0 };
}

function routeStepBlocked(
  segment: EditorGeometryRect,
  point: GridPoint,
  rooms: readonly EditorRoom[],
  fromId: string,
  toId: string,
  used: readonly EditorGeometryRect[],
  leavingStart: boolean,
  enteringEnd: boolean,
): boolean {
  if (used.some((rect) => rectsOverlap(segment, rect))) return true;
  for (const room of rooms) {
    const rect = { x: room.x, y: room.y, width: room.width, height: room.height };
    if (point.x > rect.x && point.x < rect.x + rect.width && point.y > rect.y && point.y < rect.y + rect.height) return true;
    if (!rectsOverlap(segment, rect)) continue;
    if (room.id === fromId && leavingStart) continue;
    if (room.id === toId && enteringEnd) continue;
    return true;
  }
  return false;
}

function rectsOverlap(left: EditorGeometryRect, right: EditorGeometryRect): boolean {
  const epsilon = 0.001;
  return left.x < right.x + right.width - epsilon
    && left.x + left.width > right.x + epsilon
    && left.y < right.y + right.height - epsilon
    && left.y + left.height > right.y + epsilon;
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
      const outsideFixed = edge.fixed + (edge.axis === "h" ? edge.outsideY : edge.outsideX);
      const relevant = rects.filter((other) => {
        const projectionStart = edge.axis === "h" ? other.x : other.y;
        const projectionEnd = projectionStart + (edge.axis === "h" ? other.width : other.height);
        const crossesOutside = edge.axis === "h"
          ? outsideFixed >= other.y && outsideFixed <= other.y + other.height
          : outsideFixed >= other.x && outsideFixed <= other.x + other.width;
        return crossesOutside && projectionEnd >= edge.start && projectionStart <= edge.end;
      });
      for (const other of relevant) {
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
        if (relevant.some((other) => pointInRect(x, y, other))) continue;
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

function routingBounds(rooms: readonly EditorRoom[], width = 1) {
  const margin = Math.max(4, width + 1);
  return {
    minX: Math.min(...rooms.map((room) => room.x)) - margin,
    minY: Math.min(...rooms.map((room) => room.y)) - margin,
    maxX: Math.max(...rooms.map((room) => room.x + room.width)) + margin,
    maxY: Math.max(...rooms.map((room) => room.y + room.height)) + margin,
  };
}

function roomsOverlap(left: EditorRoom, right: EditorRoom): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x && left.y < right.y + right.height && left.y + left.height > right.y;
}

function pointInRect(x: number, y: number, rect: EditorGeometryRect): boolean {
  return x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height;
}

function searchKey(x: number, y: number, direction: string): string { return `${x}:${y}:${direction}`; }
function manhattan(left: GridPoint, right: GridPoint): number { return Math.abs(left.x - right.x) + Math.abs(left.y - right.y); }
function countBends(points: readonly EditorGeometryPoint[]): number { return Math.max(0, compressPoints(points).length - 2); }
function routeSignature(points: readonly EditorGeometryPoint[]): string { return points.map((point) => `${point.x},${point.y}`).join("|"); }
function polylineLength(points: readonly EditorGeometryPoint[]): number { return points.slice(1).reduce((total, point, index) => total + Math.abs(point.x - points[index]!.x) + Math.abs(point.y - points[index]!.y), 0); }
function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
