import type { ClassDefinition, HeroClassId } from "../domain/types";
import { CLASS_COMBAT_RULES } from "@five-days/game-core";

export const CLASS_DEFINITIONS: Record<HeroClassId, ClassDefinition> = {
  swordsman: {
    id: "swordsman",
    name: "검사",
    epithet: "전선을 가르는 신참",
    description: "위험한 거리까지 파고들어 연속 참격으로 적 무리를 끊어냅니다.",
    color: 0xf2c35c,
    cssColor: "#f2c35c",
    accentColor: "#fff1b2",
    role: "근접 · 연격 · 생존",
    attackKind: "melee",
    stats: {
      maxHp: CLASS_COMBAT_RULES.swordsman.hp,
      attack: CLASS_COMBAT_RULES.swordsman.attackDamage,
      defense: 0,
      moveSpeed: CLASS_COMBAT_RULES.swordsman.speed,
      attackIntervalMs: CLASS_COMBAT_RULES.swordsman.attackInterval * 1000,
      attackRange: CLASS_COMBAT_RULES.swordsman.attackRange,
      skillPower: 1,
      projectileCount: 1,
    },
    skills: [
      { key: "Q", name: "폭풍 베기", description: "주변을 크게 베어 여러 적을 동시에 공격합니다.", cooldownMs: 5000 },
      { key: "E", name: "돌진 처형", description: "가장 가까운 적을 향해 돌진하며 일렬의 적을 꿰뚫습니다.", cooldownMs: 7000 },
    ],
  },
  archer: {
    id: "archer",
    name: "궁수",
    epithet: "길목을 꿰뚫는 신참",
    description: "긴 사거리와 빠른 공격으로 탐험과 기지 방어를 안정적으로 수행합니다.",
    color: 0x8fd99d,
    cssColor: "#8fd99d",
    accentColor: "#d9ffe2",
    role: "원거리 · 관통 · 지속 화력",
    attackKind: "projectile",
    stats: {
      maxHp: CLASS_COMBAT_RULES.archer.hp,
      attack: CLASS_COMBAT_RULES.archer.attackDamage,
      defense: 0,
      moveSpeed: CLASS_COMBAT_RULES.archer.speed,
      attackIntervalMs: CLASS_COMBAT_RULES.archer.attackInterval * 1000,
      attackRange: CLASS_COMBAT_RULES.archer.attackRange,
      skillPower: 1,
      projectileCount: 1,
    },
    skills: [
      { key: "Q", name: "집중 사격", description: "가장 가까운 적에게 강력한 화살 세 발을 집중합니다.", cooldownMs: 4200 },
      { key: "E", name: "화살비", description: "적이 모인 지점에 화살을 퍼부어 넓은 범위를 공격합니다.", cooldownMs: 7200 },
    ],
  },
  mage: {
    id: "mage",
    name: "마법사",
    epithet: "한 방을 준비한 신참",
    description: "느리지만 강력한 범위 마법으로 밀집한 적과 게이트를 폭파합니다.",
    color: 0xc69bff,
    cssColor: "#c69bff",
    accentColor: "#f0ddff",
    role: "원거리 · 폭발 · 순간 화력",
    attackKind: "magic",
    stats: {
      maxHp: CLASS_COMBAT_RULES.mage.hp,
      attack: CLASS_COMBAT_RULES.mage.attackDamage,
      defense: 0,
      moveSpeed: CLASS_COMBAT_RULES.mage.speed,
      attackIntervalMs: CLASS_COMBAT_RULES.mage.attackInterval * 1000,
      attackRange: CLASS_COMBAT_RULES.mage.attackRange,
      skillPower: 1.15,
      projectileCount: 1,
    },
    skills: [
      { key: "Q", name: "비전 구체", description: "가장 가까운 적을 추적하는 강력한 마력탄을 발사합니다.", cooldownMs: 5200 },
      { key: "E", name: "운석 낙하", description: "적이 모인 지점에 운석을 떨어뜨려 광역 피해를 줍니다.", cooldownMs: 6900 },
    ],
  },
};


