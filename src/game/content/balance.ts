import type { Phase, SessionMode } from "../domain/types";

export const WORLD = {
  width: 2560,
  height: 1600,
  base: { x: 280, y: 1320, radius: 82, maxHp: 500 },
  arena: { x: 2210, y: 250, radius: 300 },
  gates: [
    { id: "meadow", name: "들판의 균열", x: 780, y: 1190, zone: 1, hp: 90 },
    { id: "forest", name: "오염 숲의 균열", x: 1440, y: 820, zone: 2, hp: 170 },
    { id: "castle", name: "마왕성 외곽의 균열", x: 2050, y: 480, zone: 3, hp: 260 },
  ],
  buildBounds: { minX: 80, maxX: 640, minY: 1030, maxY: 1520 },
  gridSize: 40,
} as const;

export const SESSION_DURATIONS: Record<SessionMode, Record<Exclude<Phase, "boss" | "ended">, number>> = {
  prototype: { day: 60, night: 25, standby: 5 },
  full: { day: 210, night: 75, standby: 15 },
};

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
  grunt: { hp: 12, damage: 7, speed: 82, rewardXp: 5, rewardGold: 4 },
  runner: { hp: 8, damage: 5, speed: 130, rewardXp: 5, rewardGold: 4 },
  elite: { hp: 55, damage: 13, speed: 64, rewardXp: 20, rewardGold: 15 },
  boss: { hp: 500, damage: 18, speed: 0, rewardXp: 0, rewardGold: 0 },
} as const;
