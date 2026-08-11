export const DIFFICULTY = {
  easy: { enemyHp: 0.82, enemyDamage: 0.78, enemySpeed: 0.94, reward: 1 },
  normal: { enemyHp: 1, enemyDamage: 1, enemySpeed: 1, reward: 1 },
  hard: { enemyHp: 1.25, enemyDamage: 1.18, enemySpeed: 1.06, reward: 1.25 },
} as const;

export const BUILDINGS = {
  turret: { cost: 45, upgradeCost: [0, 55, 85], maxLevel: 3 },
  wall: { cost: 28, upgradeCost: [0, 38, 58], maxLevel: 3 },
} as const;

