export const DIFFICULTY = {
  easy: { enemyHp: 0.82, enemyDamage: 0.78, enemySpeed: 0.94, reward: 1 },
  normal: { enemyHp: 1, enemyDamage: 1, enemySpeed: 1, reward: 1 },
  hard: { enemyHp: 1.25, enemyDamage: 1.18, enemySpeed: 1.06, reward: 1.25 },
} as const;

export const BUILDINGS = {
  turret: { cost: 45, upgradeCost: [0, 55, 85], maxLevel: 3 },
  wall: { cost: 28, upgradeCost: [0, 38, 58], maxLevel: 3 },
} as const;

export const ENEMY_ARCHETYPES = {
  grunt: { hp: 32, damage: 7, speed: 82, rewardXp: 4, rewardGold: 4 },
  runner: { hp: 20, damage: 5, speed: 135, rewardXp: 3, rewardGold: 3 },
  elite: { hp: 450, damage: 24, speed: 78, rewardXp: 120, rewardGold: 45 },
  gate: { hp: 220, damage: 0, speed: 0, rewardXp: 30, rewardGold: 25 },
  boss: { hp: 1600, damage: 32, speed: 60, rewardXp: 200, rewardGold: 100 },
} as const;

