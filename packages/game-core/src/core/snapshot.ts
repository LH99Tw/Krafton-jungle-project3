import type { GameCore } from "./GameCore";
import type { CoreViewSnapshot } from "./types";

export function createCoreViewSnapshot(core: GameCore): CoreViewSnapshot {
  return {
    phase: core.phase,
    result: core.result,
    resultReason: core.resultReason,
    day: core.day,
    elapsed: core.elapsed,
    phaseRemaining: core.phaseRemaining,
    baseHp: core.baseHp,
    baseMaxHp: core.baseMaxHp,
    currentZone: core.currentZone,
    teamLevel: core.teamLevel,
    teamXp: core.teamXp,
    teamXpToNext: core.teamXpToNext,
    players: [...core.players.values()],
    rooms: [...core.rooms.values()].filter((room) => room.discovered),
    doors: [...core.doors.values()].filter((door) => core.discoveredRooms.has(door.fromRoomId) || core.discoveredRooms.has(door.toRoomId)),
    enemies: [...core.enemies.values()].filter((enemy) => (
      core.discoveredRooms.has(enemy.roomId) || core.activatedEnemyRooms.has(enemy.roomId)
    )),
    drops: [...core.drops.values()],
    waypoints: [...core.waypoints.values()].filter((waypoint) => core.discoveredRooms.has(waypoint.roomId)),
    specialRooms: [...core.specialRooms.values()].filter((room) => core.discoveredRooms.has(room.roomId)),
  };
}
