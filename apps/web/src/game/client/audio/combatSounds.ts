import type { HeroClassId } from "../../domain/types";

export const COMBAT_SOUND_PATHS = {
  "combat-swordsman-basic": "/audio/combat/swordsman-basic.ogg",
  "combat-swordsman-q": "/audio/combat/swordsman-q.ogg",
  "combat-swordsman-e": "/audio/combat/swordsman-e.ogg",
  "combat-archer-basic": "/audio/combat/archer-basic.ogg",
  "combat-archer-q": "/audio/combat/archer-q.ogg",
  "combat-archer-e": "/audio/combat/archer-e.ogg",
  "combat-mage-basic": "/audio/combat/mage-basic-v2.ogg",
  "combat-mage-q": "/audio/combat/mage-q-v2.ogg",
  "combat-mage-e": "/audio/combat/mage-e-v2.ogg",
} as const;

export type CombatSoundAction = "basic" | "q" | "e";

export function combatSoundKey(heroClass: HeroClassId, action: CombatSoundAction): keyof typeof COMBAT_SOUND_PATHS {
  return `combat-${heroClass}-${action}`;
}
