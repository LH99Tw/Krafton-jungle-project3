import {
  AUGMENT_BY_ID,
  AUGMENT_DEFINITIONS,
  type AugmentId,
} from "@five-days/game-core";
import type { UpgradeDefinition, UpgradeId } from "../domain/types";

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

const UPGRADE_DEFINITIONS: UpgradeDefinition[] = AUGMENT_DEFINITIONS.map((augment) =>
  toUpgradeDefinition(augment.id),
);

export const UPGRADE_MAP = new Map<UpgradeId, UpgradeDefinition>(
  UPGRADE_DEFINITIONS.map((upgrade) => [upgrade.id, upgrade]),
);
