import type { RoomMapCell } from "./types";

export type SharedPartyProgressInput = {
  baseHp: number;
  baseMaxHp: number;
  currentZone: number;
  teamLevel: number;
  teamXp: number;
  teamXpToNext: number;
  rooms: RoomMapCell[];
};

export function resolveRoundGateProgress(currentZone: number, rooms: readonly RoomMapCell[]) {
  const gateGoals: Record<number, number> = { 1: 2, 2: 3, 3: 3 };
  const currentGates = rooms.filter((room) => room.zone === currentZone && room.type === "gate");
  return {
    round: currentZone,
    destroyed: currentGates.filter((room) => room.cleared).length,
    goal: gateGoals[currentZone] ?? currentGates.length,
  };
}

export function resolveSharedPartyProgress(input: SharedPartyProgressInput) {
  const roomMap = input.rooms;
  const currentZone = input.currentZone;
  return {
    baseHp: input.baseHp,
    baseMaxHp: input.baseMaxHp,
    level: input.teamLevel,
    xp: input.teamXp,
    xpToNext: input.teamXpToNext,
    currentZone,
    gatesDestroyed: roomMap.filter((room) => room.type === "gate" && room.cleared).length,
    roomsExplored: roomMap.filter((room) => room.zone === currentZone && room.visited).length,
    roomMap,
  };
}
