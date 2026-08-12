import type { RoomMapCell } from "./types";

export type SharedPartyProgressInput = {
  baseHp: number;
  baseMaxHp: number;
  gold: number;
  currentZone: number;
  teamLevel: number;
  teamXp: number;
  teamXpToNext: number;
  rooms: RoomMapCell[];
};

export function resolveRoundGateProgress(currentZone: number, rooms: readonly RoomMapCell[]) {
  const currentGate = rooms.find((room) => room.zone === currentZone && room.type === "gate");
  return {
    round: currentZone,
    destroyed: currentGate?.cleared ? 1 : 0,
    goal: 1,
  };
}

export function resolveSharedPartyProgress(input: SharedPartyProgressInput) {
  const roomMap = input.rooms;
  const currentZone = input.currentZone;
  return {
    baseHp: input.baseHp,
    baseMaxHp: input.baseMaxHp,
    gold: input.gold,
    level: input.teamLevel,
    xp: input.teamXp,
    xpToNext: input.teamXpToNext,
    currentZone,
    gatesDestroyed: roomMap.filter((room) => room.type === "gate" && room.cleared).length,
    roomsExplored: roomMap.filter((room) => room.zone === currentZone && room.visited).length,
    roomMap,
  };
}
