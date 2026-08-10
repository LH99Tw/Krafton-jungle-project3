import {
  AUGMENT_BY_ID,
  AUGMENT_DEFINITIONS,
  createAugmentDraft,
  type AugmentId,
  type AugmentStacks,
} from "@five-days/game-core";
import type { HeroClassId, UpgradeDefinition, UpgradeId } from "../domain/types";

function toUpgradeDefinition(id: AugmentId): UpgradeDefinition {
  const augment = AUGMENT_BY_ID.get(id);
  if (!augment) throw new Error(`Unknown shared augment: ${id}`);
  return {
    id: augment.id,
    name: augment.name,
    description: augment.description,
    tag: augment.pool === "milestone" ? "전직" : "공용",
    classId: augment.classId,
    maxStacks: augment.maxStacks,
    rarity: augment.rarity,
  };
}

export const UPGRADE_DEFINITIONS: UpgradeDefinition[] = AUGMENT_DEFINITIONS.map((augment) =>
  toUpgradeDefinition(augment.id),
);

export const UPGRADE_MAP = new Map<UpgradeId, UpgradeDefinition>(
  UPGRADE_DEFINITIONS.map((upgrade) => [upgrade.id, upgrade]),
);

export type UpgradeDraftContext = {
  runSeed: string | number;
  playerId: string;
  draftIndex?: number;
};

/**
 * Compatibility adapter for the legacy scene. New room gameplay uses the same
 * game-core draft rules directly, so both runtimes stay on the attack-only
 * pool and the 10/20/30 milestone schedule.
 */
export function draftUpgrades(
  heroClass: HeroClassId,
  stacks: ReadonlyMap<UpgradeId, number>,
  level: number,
  _random: () => number = Math.random,
  context: UpgradeDraftContext = { runSeed: "legacy", playerId: "local" },
): UpgradeDefinition[] {
  void _random;
  const sharedStacks: Partial<Record<AugmentId, number>> = {};
  for (const [id, stack] of stacks) {
    if (AUGMENT_BY_ID.has(id as AugmentId)) sharedStacks[id as AugmentId] = stack;
  }
  const choices = createAugmentDraft({
    runSeed: context.runSeed,
    playerId: context.playerId,
    heroClass,
    level,
    stacks: sharedStacks as AugmentStacks,
    draftIndex: context.draftIndex,
  });
  return choices.map((choice) => toUpgradeDefinition(choice.id));
}
