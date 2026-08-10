import type { HeroClassId, UpgradeDefinition, UpgradeId } from "../domain/types";

export const UPGRADE_DEFINITIONS: UpgradeDefinition[] = [
  { id: "power", name: "무모한 연마", description: "공격력 +3", tag: "공용", maxStacks: 4, rarity: "normal" },
  { id: "haste", name: "신속의 문장", description: "자동 공격 속도 +12%", tag: "공용", maxStacks: 4, rarity: "normal" },
  { id: "vitality", name: "야영지 식사", description: "최대 체력 +18, 즉시 회복", tag: "공용", maxStacks: 3, rarity: "normal" },
  { id: "armor", name: "급조한 견갑", description: "방어력 +1", tag: "공용", maxStacks: 3, rarity: "normal" },
  { id: "mobility", name: "가벼운 장화", description: "이동 속도 +8%", tag: "공용", maxStacks: 3, rarity: "rare" },
  { id: "multishot", name: "쌍둥이 별", description: "투사체 +1 또는 근접 범위 +20%", tag: "공용", maxStacks: 2, rarity: "epic" },
  { id: "skill-power", name: "불안정한 마력", description: "스킬 위력 +22%", tag: "공용", maxStacks: 3, rarity: "rare" },
  { id: "base-link", name: "거점 공명", description: "기지 주변에서 공격력 +30%", tag: "공용", maxStacks: 1, rarity: "rare" },
  { id: "swordsman-blade", name: "검기 개방", description: "검격이 짧은 검기를 발사합니다.", tag: "전직", classId: "swordsman", maxStacks: 1, rarity: "epic" },
  { id: "swordsman-execution", name: "처형자", description: "체력 30% 이하 적에게 피해 +60%", tag: "검사", classId: "swordsman", maxStacks: 1, rarity: "epic" },
  { id: "archer-volley", name: "탄막 사수", description: "자동 공격이 부채꼴로 추가 발사됩니다.", tag: "전직", classId: "archer", maxStacks: 1, rarity: "epic" },
  { id: "archer-sniper", name: "명사수", description: "먼 적에게 주는 피해가 최대 55% 증가합니다.", tag: "궁수", classId: "archer", maxStacks: 1, rarity: "epic" },
  { id: "mage-nova", name: "파괴술사", description: "마력탄과 룬의 폭발 범위 +55%", tag: "전직", classId: "mage", maxStacks: 1, rarity: "epic" },
  { id: "mage-tempo", name: "시공술사", description: "스킬 재사용 대기시간 -25%", tag: "마법사", classId: "mage", maxStacks: 1, rarity: "epic" },
];

export const UPGRADE_MAP = new Map<UpgradeId, UpgradeDefinition>(
  UPGRADE_DEFINITIONS.map((upgrade) => [upgrade.id, upgrade]),
);

export function draftUpgrades(
  heroClass: HeroClassId,
  stacks: ReadonlyMap<UpgradeId, number>,
  level: number,
  random: () => number = Math.random,
): UpgradeDefinition[] {
  const isMilestone = level === 3 || level === 6 || level === 9;
  const candidates = UPGRADE_DEFINITIONS.filter((upgrade) => {
    const current = stacks.get(upgrade.id) ?? 0;
    if (current >= upgrade.maxStacks) return false;
    if (upgrade.classId && upgrade.classId !== heroClass) return false;
    if (isMilestone) return upgrade.rarity === "epic" || upgrade.classId === heroClass;
    return upgrade.tag !== "전직";
  });

  const weighted = candidates.flatMap((upgrade) => {
    const weight = upgrade.rarity === "normal" ? 4 : upgrade.rarity === "rare" ? 2 : 1;
    return Array.from({ length: weight }, () => upgrade);
  });
  const selected: UpgradeDefinition[] = [];

  while (selected.length < 3 && weighted.length > 0) {
    const index = Math.floor(random() * weighted.length);
    const candidate = weighted[index];
    if (!selected.some((item) => item.id === candidate.id)) selected.push(candidate);
    for (let i = weighted.length - 1; i >= 0; i -= 1) {
      if (weighted[i].id === candidate.id) weighted.splice(i, 1);
    }
  }

  return selected;
}

