import type { ClassDefinition, HeroClassId } from "../domain/types";

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
      maxHp: 110,
      attack: 9,
      defense: 3,
      moveSpeed: 220,
      attackIntervalMs: 440,
      attackRange: 105,
      skillPower: 1,
      projectileCount: 1,
    },
    skills: [
      { key: "Q", name: "초승달 베기", description: "전방 넓은 범위를 크게 벱니다.", cooldownMs: 4800 },
      { key: "E", name: "용기 충전", description: "조준 방향으로 돌진하며 적을 관통합니다.", cooldownMs: 6500 },
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
      maxHp: 82,
      attack: 6,
      defense: 1,
      moveSpeed: 235,
      attackIntervalMs: 360,
      attackRange: 460,
      skillPower: 1,
      projectileCount: 1,
    },
    skills: [
      { key: "Q", name: "꿰뚫는 화살", description: "긴 직선의 적을 모두 관통합니다.", cooldownMs: 4200 },
      { key: "E", name: "화살비", description: "지정 구역에 연속 피해를 줍니다.", cooldownMs: 7200 },
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
      maxHp: 74,
      attack: 8,
      defense: 1,
      moveSpeed: 210,
      attackIntervalMs: 620,
      attackRange: 390,
      skillPower: 1.15,
      projectileCount: 1,
    },
    skills: [
      { key: "Q", name: "붕괴 룬", description: "지정 위치를 폭발시켜 범위 피해를 줍니다.", cooldownMs: 5200 },
      { key: "E", name: "잔상 도약", description: "순간이동 후 출발 지점을 폭발시킵니다.", cooldownMs: 6900 },
    ],
  },
};

export const CLASS_ORDER: HeroClassId[] = ["swordsman", "archer", "mage"];

