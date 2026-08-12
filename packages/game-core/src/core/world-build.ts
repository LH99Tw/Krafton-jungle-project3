import {
  createSeededRoomEnemy,
  doorId,
  waypointId,
  FAST_TRAVEL_HOLD_SECONDS,
  type CoreDoor,
  type CoreEnemy,
  type CoreRoom,
  type CoreRoomId,
  type CoreWaypoint,
  type CoreWorldDefinition,
  type RuntimeWorld,
} from "../v02/simulation";
import type { ThreeZoneMap } from "../v02/map";
import { createSeededRandom } from "../v02/random";
import type { GameCoreOptions } from "./types";
import type { BalancePartySize } from "../v02/balance";

export function createAuthoredRuntimeWorld(
  definition: CoreWorldDefinition,
  seed: string,
  difficulty: GameCoreOptions["difficulty"],
  balancePartySize: BalancePartySize = 1,
): RuntimeWorld {
  const activeGateCandidates = selectGateCandidates(definition, seed);
  const rooms = new Map<CoreRoomId, CoreRoom>();
  const doors = new Map<string, CoreDoor>();
  const enemies = new Map<string, CoreEnemy>();
  const waypoints = new Map<string, CoreWaypoint>();
  for (const room of definition.rooms) {
    const runtimeKind = room.kind === "gate-candidate"
      ? activeGateCandidates.has(room.id) ? "gate" : "static-monster"
      : room.kind;
    rooms.set(room.id, {
      id: room.id,
      zone: room.zone,
      gridX: room.mapX,
      gridY: room.mapY,
      kind: runtimeKind,
      depth: room.depth,
      connections: room.connections,
      discovered: room.id === definition.baseRoomId,
      cleared: ["start", "empty", "central-waypoint", "shrine", "checkpoint", "altar"].includes(runtimeKind),
      rect: room.rect,
    });
    const enemyKind = runtimeKind === "static-monster" ? "static"
      : runtimeKind === "hidden-monster" ? "hidden"
        : runtimeKind === "gate" ? "gate" : null;
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
        balancePartySize,
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
    holdDurationMs: FAST_TRAVEL_HOLD_SECONDS * 1_000,
  });
  for (const room of rooms.values()) {
    if (room.kind !== "checkpoint") continue;
    const center = room.rect
      ? { x: room.rect.x + room.rect.width / 2, y: room.rect.y + room.rect.height / 2 }
      : baseCenter;
    const id = waypointId(room.id, "checkpoint");
    waypoints.set(id, {
      id,
      roomId: room.id,
      zone: room.zone,
      kind: "checkpoint",
      ...center,
      destinationId: baseWaypointId,
      active: false,
      requiredPlayers: 0,
      holdingPlayers: 0,
      holdProgress: 0,
      holdDurationMs: 3_000,
    });
  }

  const zones = ([1, 2, 3] as const).map((zone) => {
    const authoredRooms = definition.rooms.filter((room) => room.zone === zone && room.kind !== "boss");
    const fallback = authoredRooms[0]?.id ?? definition.baseRoomId;
    const startRoomId = zone === 1 ? definition.baseRoomId : fallback;
    const gateRoomId = [...rooms.values()].find((room) => room.zone === zone && room.kind === "gate")?.id ?? fallback;
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

function selectGateCandidates(definition: CoreWorldDefinition, seed: string): Set<CoreRoomId> {
  const selected = new Set<CoreRoomId>(definition.gateRoomIds);
  const candidates = new Set(definition.gateCandidateRoomIds ?? []);
  for (const zone of [1, 2, 3] as const) {
    const pool = definition.rooms
      .filter((room) => room.zone === zone && room.kind === "gate-candidate" && candidates.has(room.id))
      .map((room) => room.id);
    const random = createSeededRandom(`gate-candidates:${seed}:zone:${zone}`);
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random.next() * (index + 1));
      [pool[index], pool[swap]] = [pool[swap]!, pool[index]!];
    }
    for (const roomId of pool.slice(0, 3)) selected.add(roomId);
  }
  return selected;
}
