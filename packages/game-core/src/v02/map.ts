import { createSeededRandom, type RandomSource } from "./random";

export const ZONE_GRID_SIZE = 5;
export const ROOMS_PER_ZONE = 15;
export const START_POSITION = { x: 0, y: 4 } as const;
export const GATE_POSITION = { x: 4, y: 0 } as const;

export type ZoneId = 1 | 2 | 3;
export type RoomId = `zone-${ZoneId}:${number},${number}`;
export type RoomType =
  | "start"
  | "gate"
  | "resource"
  | "static-monster"
  | "empty"
  | "central-waypoint"
  | "hidden-monster";

export type GridPosition = Readonly<{ x: number; y: number }>;

export type ZoneRoom = Readonly<{
  id: RoomId;
  zone: ZoneId;
  x: number;
  y: number;
  type: RoomType;
  /** Orthogonally adjacent room IDs, sorted for stable serialization. */
  connections: readonly RoomId[];
  /** dist(start, room) + dist(gate, room), using graph shortest paths. */
  depthScore: number;
}>;

export type ZoneMap = Readonly<{
  seed: string;
  zone: ZoneId;
  width: typeof ZONE_GRID_SIZE;
  height: typeof ZONE_GRID_SIZE;
  startRoomId: RoomId;
  gateRoomId: RoomId;
  rooms: readonly ZoneRoom[];
}>;

export type ThreeZoneMap = Readonly<{
  seed: string;
  zones: readonly [ZoneMap, ZoneMap, ZoneMap];
}>;

const RANDOM_ROOM_TYPES: readonly RoomType[] = [
  "resource",
  "resource",
  "resource",
  "resource",
  "static-monster",
  "static-monster",
  "static-monster",
  "static-monster",
  "empty",
  "empty",
] as const;

const EXPECTED_TYPE_COUNTS: Readonly<Record<RoomType, number>> = {
  start: 1,
  gate: 1,
  resource: 4,
  "static-monster": 4,
  empty: 2,
  "central-waypoint": 1,
  "hidden-monster": 2,
};

type MutableRoom = {
  position: GridPosition;
  type: RoomType;
};

/**
 * Generates all three deterministic 0.2 zones from one run seed.
 * Coordinates use current screen space: y=0 is the top row, hence the
 * lower-left start is (0,4) and the upper-right gate is (4,0).
 */
export function generateThreeZoneMap(seed: string | number): ThreeZoneMap {
  const normalizedSeed = String(seed);
  return {
    seed: normalizedSeed,
    zones: [
      generateZoneMap(normalizedSeed, 1),
      generateZoneMap(normalizedSeed, 2),
      generateZoneMap(normalizedSeed, 3),
    ],
  };
}

export function generateZoneMap(seed: string | number, zone: ZoneId): ZoneMap {
  const normalizedSeed = String(seed);

  for (let attempt = 0; attempt < 2_048; attempt += 1) {
    const random = createSeededRandom(`${normalizedSeed}:zone:${zone}:layout:${attempt}`);
    const core = createConnectedCore(random, zone);
    const hiddenPair = selectHiddenPair(core, random);
    if (!hiddenPair) continue;

    const map = materializeZone(normalizedSeed, zone, core, hiddenPair, random);
    if (validateZoneMap(map).length === 0) return map;
  }

  throw new Error(`Unable to generate a valid zone ${zone} for seed ${normalizedSeed}`);
}

/** Returns human-readable invariant failures; an empty array means valid. */
export function validateZoneMap(map: ZoneMap): string[] {
  const failures: string[] = [];
  if (map.width !== ZONE_GRID_SIZE || map.height !== ZONE_GRID_SIZE) failures.push("grid must be 5x5");
  if (map.rooms.length !== ROOMS_PER_ZONE) failures.push("zone must contain exactly 15 rooms");

  const byId = new Map(map.rooms.map((room) => [room.id, room]));
  const positions = new Set<string>();
  const typeCounts = new Map<RoomType, number>();
  for (const room of map.rooms) {
    if (!isInsideGrid(room)) failures.push(`room ${room.id} is outside the grid`);
    const key = positionKey(room);
    if (positions.has(key)) failures.push(`duplicate room position ${key}`);
    positions.add(key);
    typeCounts.set(room.type, (typeCounts.get(room.type) ?? 0) + 1);

    for (const connectionId of room.connections) {
      const neighbor = byId.get(connectionId);
      if (!neighbor) {
        failures.push(`room ${room.id} references missing connection ${connectionId}`);
        continue;
      }
      if (manhattan(room, neighbor) !== 1) failures.push(`connection ${room.id} -> ${connectionId} is not orthogonal`);
      if (!neighbor.connections.includes(room.id)) failures.push(`connection ${room.id} -> ${connectionId} is not symmetric`);
    }
  }

  for (const [type, expected] of Object.entries(EXPECTED_TYPE_COUNTS) as [RoomType, number][]) {
    if ((typeCounts.get(type) ?? 0) !== expected) failures.push(`${type} count must be ${expected}`);
  }

  const start = roomAt(map, START_POSITION);
  const gate = roomAt(map, GATE_POSITION);
  if (start?.type !== "start") failures.push("start room must be at (0,4)");
  if (gate?.type !== "gate") failures.push("gate room must be at (4,0)");

  if (start) {
    const visited = new Set<RoomId>([start.id]);
    const queue: RoomId[] = [start.id];
    while (queue.length > 0) {
      const current = byId.get(queue.shift() as RoomId);
      if (!current) continue;
      for (const next of current.connections) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    if (visited.size !== map.rooms.length) failures.push("every room must be reachable from the start");
  }

  const hiddenRooms = map.rooms.filter((room) => room.type === "hidden-monster");
  if (hiddenRooms.some((room) => room.connections.length !== 1)) failures.push("hidden rooms must have degree one");
  if (hiddenRooms.length === 2) {
    const nonSpecialScores = map.rooms
      .filter((room) => room.type !== "start" && room.type !== "gate")
      .map((room) => room.depthScore)
      .sort((left, right) => right - left);
    const secondDeepest = nonSpecialScores[1] ?? Number.NEGATIVE_INFINITY;
    if (hiddenRooms.some((room) => room.depthScore < secondDeepest)) {
      failures.push("hidden rooms must be among the two deepest rooms");
    }
  }

  if (map.zone === 1 && start) {
    const right = roomAt(map, { x: 1, y: 4 });
    const up = roomAt(map, { x: 0, y: 3 });
    if (!right || !start.connections.includes(right.id)) failures.push("zone 1 start must link right");
    if (!up || !start.connections.includes(up.id)) failures.push("zone 1 start must link up");
  }

  return failures;
}

export function roomAt(map: ZoneMap, position: GridPosition): ZoneRoom | undefined {
  return map.rooms.find((room) => room.x === position.x && room.y === position.y);
}

function createConnectedCore(random: RandomSource, zone: ZoneId): Set<string> {
  const core = new Set<string>();
  const pathSteps = random.shuffle([
    { x: 1, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: -1 },
    { x: 0, y: -1 },
    { x: 0, y: -1 },
    { x: 0, y: -1 },
  ] as const);

  let cursor: GridPosition = START_POSITION;
  core.add(positionKey(cursor));
  for (const step of pathSteps) {
    cursor = { x: cursor.x + step.x, y: cursor.y + step.y };
    core.add(positionKey(cursor));
  }

  if (zone === 1) {
    core.add(positionKey({ x: 1, y: 4 }));
    core.add(positionKey({ x: 0, y: 3 }));
  }

  while (core.size < ROOMS_PER_ZONE - 2) {
    const frontier = allGridPositions().filter((position) => {
      const key = positionKey(position);
      return !core.has(key) && neighbors(position).some((neighbor) => core.has(positionKey(neighbor)));
    });
    if (frontier.length === 0) throw new Error("Connected core ran out of frontier cells");
    core.add(positionKey(random.pick(frontier)));
  }

  return core;
}

function selectHiddenPair(core: ReadonlySet<string>, random: RandomSource): readonly [GridPosition, GridPosition] | null {
  const leafCandidates = allGridPositions().filter((position) => {
    if (core.has(positionKey(position))) return false;
    return neighbors(position).filter((neighbor) => core.has(positionKey(neighbor))).length === 1;
  });

  const pairs: Array<readonly [GridPosition, GridPosition]> = [];
  for (let left = 0; left < leafCandidates.length; left += 1) {
    for (let right = left + 1; right < leafCandidates.length; right += 1) {
      const first = leafCandidates[left] as GridPosition;
      const second = leafCandidates[right] as GridPosition;
      if (manhattan(first, second) === 1) continue;
      pairs.push([first, second]);
    }
  }

  const ranked = random.shuffle(pairs).map((pair) => {
    const positions = new Set(core);
    positions.add(positionKey(pair[0]));
    positions.add(positionKey(pair[1]));
    const graph = createPositionGraph(positions);
    const fromStart = graphDistances(graph, positionKey(START_POSITION));
    const fromGate = graphDistances(graph, positionKey(GATE_POSITION));
    const scores = [...positions]
      .filter((key) => key !== positionKey(START_POSITION) && key !== positionKey(GATE_POSITION))
      .map((key) => (fromStart.get(key) ?? 0) + (fromGate.get(key) ?? 0));
    scores.sort((left, right) => right - left);
    const secondDeepest = scores[1] ?? Number.NEGATIVE_INFINITY;
    const firstScore = (fromStart.get(positionKey(pair[0])) ?? 0) + (fromGate.get(positionKey(pair[0])) ?? 0);
    const secondScore = (fromStart.get(positionKey(pair[1])) ?? 0) + (fromGate.get(positionKey(pair[1])) ?? 0);
    return {
      pair,
      valid: firstScore >= secondDeepest && secondScore >= secondDeepest,
      minimumScore: Math.min(firstScore, secondScore),
      totalScore: firstScore + secondScore,
    };
  });

  ranked.sort((left, right) => right.minimumScore - left.minimumScore || right.totalScore - left.totalScore);
  return ranked.find((candidate) => candidate.valid)?.pair ?? null;
}

function materializeZone(
  seed: string,
  zone: ZoneId,
  core: ReadonlySet<string>,
  hiddenPair: readonly [GridPosition, GridPosition],
  random: RandomSource,
): ZoneMap {
  const selected = new Set(core);
  selected.add(positionKey(hiddenPair[0]));
  selected.add(positionKey(hiddenPair[1]));
  const graph = createPositionGraph(selected);
  const fromStart = graphDistances(graph, positionKey(START_POSITION));
  const fromGate = graphDistances(graph, positionKey(GATE_POSITION));
  const hiddenKeys = new Set(hiddenPair.map(positionKey));

  const ordinary = [...core]
    .map(parsePositionKey)
    .filter((position) => !samePosition(position, START_POSITION) && !samePosition(position, GATE_POSITION));

  const nonAdjacentWaypointCandidates = ordinary.filter(
    (position) => manhattan(position, START_POSITION) > 1 && manhattan(position, GATE_POSITION) > 1,
  );
  const waypointPool = nonAdjacentWaypointCandidates.length > 0 ? nonAdjacentWaypointCandidates : ordinary;
  const waypointRanking = random.shuffle(waypointPool).map((position) => ({
    position,
    separation: Math.min(
      fromStart.get(positionKey(position)) ?? 0,
      fromGate.get(positionKey(position)) ?? 0,
    ),
  }));
  waypointRanking.sort((left, right) => right.separation - left.separation);
  const waypoint = waypointRanking[0]?.position;
  if (!waypoint) throw new Error("A central waypoint candidate is required");

  const randomTypes = random.shuffle(RANDOM_ROOM_TYPES);
  let randomTypeIndex = 0;
  const mutableRooms: MutableRoom[] = [...selected].map(parsePositionKey).map((position) => {
    const key = positionKey(position);
    let type: RoomType;
    if (samePosition(position, START_POSITION)) type = "start";
    else if (samePosition(position, GATE_POSITION)) type = "gate";
    else if (hiddenKeys.has(key)) type = "hidden-monster";
    else if (samePosition(position, waypoint)) type = "central-waypoint";
    else {
      type = randomTypes[randomTypeIndex] as RoomType;
      randomTypeIndex += 1;
    }
    return { position, type };
  });

  mutableRooms.sort((left, right) => left.position.y - right.position.y || left.position.x - right.position.x);
  const rooms: ZoneRoom[] = mutableRooms.map(({ position, type }) => {
    const key = positionKey(position);
    return {
      id: roomId(zone, position),
      zone,
      x: position.x,
      y: position.y,
      type,
      connections: (graph.get(key) ?? [])
        .map((neighborKey) => roomId(zone, parsePositionKey(neighborKey)))
        .sort(),
      depthScore: (fromStart.get(key) ?? 0) + (fromGate.get(key) ?? 0),
    };
  });

  return {
    seed: `${seed}:zone:${zone}`,
    zone,
    width: ZONE_GRID_SIZE,
    height: ZONE_GRID_SIZE,
    startRoomId: roomId(zone, START_POSITION),
    gateRoomId: roomId(zone, GATE_POSITION),
    rooms,
  };
}

function createPositionGraph(positions: ReadonlySet<string>): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const key of positions) {
    const position = parsePositionKey(key);
    graph.set(
      key,
      neighbors(position)
        .map(positionKey)
        .filter((neighborKey) => positions.has(neighborKey))
        .sort(),
    );
  }
  return graph;
}

function graphDistances(graph: ReadonlyMap<string, readonly string[]>, origin: string): Map<string, number> {
  const distances = new Map<string, number>([[origin, 0]]);
  const queue = [origin];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const distance = distances.get(current) as number;
    for (const next of graph.get(current) ?? []) {
      if (distances.has(next)) continue;
      distances.set(next, distance + 1);
      queue.push(next);
    }
  }
  return distances;
}

function allGridPositions(): GridPosition[] {
  const positions: GridPosition[] = [];
  for (let y = 0; y < ZONE_GRID_SIZE; y += 1) {
    for (let x = 0; x < ZONE_GRID_SIZE; x += 1) positions.push({ x, y });
  }
  return positions;
}

function neighbors(position: GridPosition): GridPosition[] {
  return [
    { x: position.x + 1, y: position.y },
    { x: position.x - 1, y: position.y },
    { x: position.x, y: position.y + 1 },
    { x: position.x, y: position.y - 1 },
  ].filter(isInsideGrid);
}

function isInsideGrid(position: GridPosition): boolean {
  return position.x >= 0 && position.x < ZONE_GRID_SIZE && position.y >= 0 && position.y < ZONE_GRID_SIZE;
}

function positionKey(position: GridPosition): string {
  return `${position.x},${position.y}`;
}

function parsePositionKey(key: string): GridPosition {
  const [x, y] = key.split(",").map(Number);
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error(`Invalid position key: ${key}`);
  return { x: x as number, y: y as number };
}

function roomId(zone: ZoneId, position: GridPosition): RoomId {
  return `zone-${zone}:${position.x},${position.y}`;
}

function samePosition(left: GridPosition, right: GridPosition): boolean {
  return left.x === right.x && left.y === right.y;
}

function manhattan(left: GridPosition, right: GridPosition): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}
