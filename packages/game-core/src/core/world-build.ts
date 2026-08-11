import {
  createSeededRoomEnemy,
  doorId,
  waypointId,
  WAYPOINT_HOLD_SECONDS,
  type CoreDoor,
  type CoreEnemy,
  type CoreRoom,
  type CoreRoomId,
  type CoreWaypoint,
  type CoreWorldDefinition,
  type RuntimeWorld,
} from "../v02/simulation";
import type { ThreeZoneMap } from "../v02/map";
import type { GameCoreOptions } from "./types";

export function createAuthoredRuntimeWorld(
  definition: CoreWorldDefinition,
  seed: string,
  difficulty: GameCoreOptions["difficulty"],
): RuntimeWorld {
  const rooms = new Map<CoreRoomId, CoreRoom>();
  const doors = new Map<string, CoreDoor>();
  const enemies = new Map<string, CoreEnemy>();
  const waypoints = new Map<string, CoreWaypoint>();
  for (const room of definition.rooms) {
    rooms.set(room.id, {
      id: room.id,
      zone: room.zone,
      gridX: room.mapX,
      gridY: room.mapY,
      kind: room.kind,
      depth: room.depth,
      connections: room.connections,
      discovered: room.id === definition.baseRoomId,
      cleared: ["start", "resource", "empty", "central-waypoint"].includes(room.kind),
      rect: room.rect,
    });
    const enemyKind = room.kind === "static-monster" ? "static"
      : room.kind === "hidden-monster" ? "hidden"
        : room.kind === "gate" ? "gate" : null;
    if (enemyKind) {
      const enemy = createSeededRoomEnemy(
        seed,
        room.id,
        room.zone,
        enemyKind,
        difficulty,
        room.rect.x,
        room.rect.y,
        room.rect.width,
        room.rect.height,
      );
      enemies.set(enemy.id, enemy);
    }
  }
  for (const connection of definition.connections) {
    const from = rooms.get(connection.from);
    doors.set(doorId(connection.from, connection.to), {
      id: doorId(connection.from, connection.to),
      zone: from?.zone ?? 1,
      fromRoomId: connection.from,
      toRoomId: connection.to,
      open: true,
      locked: false,
    });
  }
  const base = rooms.get(definition.baseRoomId);
  const baseCenter = base
    ? { x: base.rect!.x + base.rect!.width / 2, y: base.rect!.y + base.rect!.height / 2 }
    : { x: 0, y: 0 };
  const baseWaypointId = waypointId(definition.baseRoomId, "start");
  waypoints.set(baseWaypointId, {
    id: baseWaypointId,
    roomId: definition.baseRoomId,
    zone: base?.zone ?? 1,
    kind: "start",
    ...baseCenter,
    destinationId: baseWaypointId,
    active: true,
    requiredPlayers: 0,
    holdingPlayers: 0,
    holdProgress: 0,
    holdDurationMs: WAYPOINT_HOLD_SECONDS * 1_000,
  });

  const zones = ([1, 2, 3] as const).map((zone) => {
    const authoredRooms = definition.rooms.filter((room) => room.zone === zone && room.kind !== "boss");
    const fallback = authoredRooms[0]?.id ?? definition.baseRoomId;
    const startRoomId = zone === 1 ? definition.baseRoomId : fallback;
    const gateRoomId = authoredRooms.find((room) => room.kind === "gate")?.id ?? fallback;
    return {
      seed,
      zone,
      width: 5,
      height: 5,
      startRoomId,
      gateRoomId,
      rooms: authoredRooms.map((room) => ({
        id: room.id,
        zone,
        x: 0,
        y: 0,
        type: room.kind === "boss" ? "empty" : room.kind,
        connections: room.connections,
        depthScore: room.depth,
      })),
    };
  });
  const maps = { seed, zones } as unknown as ThreeZoneMap;
  return { maps, rooms, doors, enemies, waypoints };
}
