import type { ZoneId } from "./map";
import { createSeededRandom, hashSeed } from "./random";

export type EquipmentRarity = "normal" | "rare" | "epic" | "legendary" | "mythic";
export type EquipmentSlot = "weapon" | "armor" | "accessory";
export type EquipmentStat = "attack" | "maxHp" | "defense" | "attackSpeed";

export type EquipmentRarityRule = Readonly<{
  statMultiplier: number;
  specialOptionCount: number;
}>;

/** 0.1 balance values promoted to an executable 0.2 rule table. */
export const EQUIPMENT_RARITIES: Readonly<Record<EquipmentRarity, EquipmentRarityRule>> = {
  normal: { statMultiplier: 0.2, specialOptionCount: 0 },
  rare: { statMultiplier: 0.4, specialOptionCount: 0 },
  epic: { statMultiplier: 0.6, specialOptionCount: 1 },
  legendary: { statMultiplier: 0.8, specialOptionCount: 0 },
  mythic: { statMultiplier: 1, specialOptionCount: 2 },
};

export const EQUIPMENT_SLOTS: Readonly<Record<EquipmentSlot, Readonly<{ stats: readonly EquipmentStat[] }>>> = {
  weapon: { stats: ["attack"] },
  armor: { stats: ["maxHp", "defense"] },
  accessory: { stats: ["attackSpeed"] },
};

export const HIDDEN_DROP_RARITY_CHANCE = {
  legendary: 0.8,
  mythic: 0.2,
} as const;

export type PersonalHiddenDrop = Readonly<{
  id: string;
  ownerPlayerId: string;
  zone: ZoneId;
  hiddenRoomId: string;
  dropIndex: number;
  rarity: EquipmentRarity;
  slot: EquipmentSlot;
  statMultiplier: number;
  specialOptionCount: number;
  /** Shop upgrades never change rarity; this level scales the item's base stat. */
  upgradeLevel?: number;
}>;

export type PersonalHiddenDropInput = Readonly<{
  runSeed: string | number;
  playerId: string;
  zone: ZoneId;
  hiddenRoomId: string;
  dropIndex?: number;
}>;

/**
 * Converts one uniform [0,1) roll into the documented hidden-room rarity.
 * The explicit boundary makes probability tests independent from the PRNG.
 */
export function rollHiddenDropRarity(randomValue: number): "legendary" | "mythic" {
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new RangeError("randomValue must be in [0, 1)");
  }
  return randomValue < HIDDEN_DROP_RARITY_CHANCE.legendary ? "legendary" : "mythic";
}

/**
 * Produces one deterministic, personal item for a hidden-monster clear.
 * Player ID is part of the seed, so one player's result does not depend on
 * party ordering or another player's join/leave state.
 */
export function rollPersonalHiddenDrop(input: PersonalHiddenDropInput): PersonalHiddenDrop {
  if (input.playerId.length === 0) throw new RangeError("playerId must not be empty");
  if (input.hiddenRoomId.length === 0) throw new RangeError("hiddenRoomId must not be empty");
  const dropIndex = input.dropIndex ?? 0;
  if (!Number.isInteger(dropIndex) || dropIndex < 0) throw new RangeError("dropIndex must be a non-negative integer");

  const itemSeed = [input.runSeed, input.zone, input.hiddenRoomId, input.playerId, dropIndex].join(":");
  const random = createSeededRandom(`hidden-drop:${itemSeed}`);
  const rarity = rollHiddenDropRarity(random.next());
  const slot = random.pick(Object.keys(EQUIPMENT_SLOTS) as EquipmentSlot[]);
  const rule = EQUIPMENT_RARITIES[rarity];
  const fingerprint = hashSeed(`item:${itemSeed}`).toString(16).padStart(8, "0");

  return {
    id: `hidden-${input.zone}-${dropIndex}-${fingerprint}`,
    ownerPlayerId: input.playerId,
    zone: input.zone,
    hiddenRoomId: input.hiddenRoomId,
    dropIndex,
    rarity,
    slot,
    statMultiplier: rule.statMultiplier,
    specialOptionCount: rule.specialOptionCount,
    upgradeLevel: 0,
  };
}

export function rollPartyHiddenDrops(
  input: Omit<PersonalHiddenDropInput, "playerId"> & Readonly<{ playerIds: readonly string[] }>,
): PersonalHiddenDrop[] {
  const uniquePlayers = new Set(input.playerIds);
  if (uniquePlayers.size !== input.playerIds.length) throw new RangeError("playerIds must be unique");
  return input.playerIds.map((playerId) => rollPersonalHiddenDrop({ ...input, playerId }));
}
