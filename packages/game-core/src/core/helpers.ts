import { equipmentPower, type CoreRoomId } from "../v02/simulation";
import type { PersonalHiddenDrop } from "../v02/equipment";
import type { HeroClassId } from "@five-days/protocol";

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clampUpdateRate(value: number): number {
  if (!Number.isFinite(value)) return 60;
  return clamp(Math.round(value), 1, 60);
}

export function pointInWorldRect(x: number, y: number, rect: { x: number; y: number; width: number; height: number }): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function aiAugmentScore(heroClass: HeroClassId, id: string): number {
  const classPriority: Record<HeroClassId, readonly string[]> = {
    swordsman: ["swordsman-execution", "swordsman-combo", "swordsman-whirlwind", "swordsman-blade", "power", "crit-loop", "combat-rhythm", "momentum", "area-power", "multishot", "skill-haste", "haste"],
    archer: ["archer-volley", "archer-piercing", "archer-ricochet", "archer-sniper", "multishot", "precision", "crit-loop", "combat-rhythm", "power", "momentum", "boss-hunter", "haste"],
    mage: ["mage-overcharge", "mage-chain", "mage-nova", "mage-echo", "skill-power", "area-power", "crit-loop", "combat-rhythm", "momentum", "skill-haste", "power", "haste"],
  };
  const index = classPriority[heroClass].indexOf(id);
  return index < 0 ? 10 : 100 - index;
}

export { aiAugmentScore };

export function deterministicCombatRoll(seed: string | number, playerId: string, attackCount: number): number {
  const value = `${seed}:${playerId}:${attackCount}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0) / 0x1_0000_0000;
}

export function shouldAiYieldEquipment(item: PersonalHiddenDrop, humanEquipment: PersonalHiddenDrop | null): boolean {
  return item.specialOptionCount === 0 && equipmentPower(item) > equipmentPower(humanEquipment);
}

/** Canonical undirected edge key shared by traversal checks and connection lookups. */
export function invaderEdgeKey(from: CoreRoomId, to: CoreRoomId): string {
  return [from, to].sort().join("|");
}
