export const durations = {
  prototype: { day: 60, night: 25, standby: 5 },
  full: { day: 120, night: 45, standby: 15 },
} as const;

export const GOLD_ROOM_REWARDS = { 1: 100, 2: 175, 3: 250 } as const;

export const RESOURCE_PRODUCTION_SECONDS = 5;
export const STATIC_RESPAWN_SECONDS = { prototype: 30, full: 90 } as const;
export const SIMULATION_EPSILON = 1e-9;
export const ACTOR_COLLISION_RADIUS = 14;
export const PLAYER_RESPAWN_SECONDS = 5;

export const INVADER_AGGRO_RADIUS = 1_400;
export const INVADER_RELEASE_RADIUS = 1_500;
export const INVADER_COMBAT_RADIUS = 480;
export const INVADER_BASE_RADIUS = 56;
export const INVADER_RETRY_SECONDS = 0.5;
export const INVADER_STALL_SECONDS = 0.75;
export const INVADER_STALL_DISTANCE = 8;
export const INVADER_BLOCKED_EDGE_SECONDS = 2;
export const INVADER_DAY_WAVES = 8;
export const INVADER_NIGHT_WAVES = 10;
export const INVADER_SPAWN_SLOTS = 24;
export const INVADER_INITIAL_SPAWN_DELAY_SECONDS = 10;
export const INVADER_MICRO_SPAWN_INTERVAL_SECONDS = 0.1;
export const INVADER_MICRO_SPAWN_COUNT = 1;
export const INVADER_REPLAN_BUDGET_PER_TICK = 8;
export const DEFAULT_MAX_LIVE_INVADERS = 256;
export const ABSOLUTE_MAX_LIVE_INVADERS = 384;
export const MAX_PENDING_INVADERS = 1_024;
export const INVADER_CORRIDOR_LANE_OFFSET = 20;

export const AI_FOLLOWER_GAP = 180;
export const AI_PATH_REPLAN_SECONDS = 0.75;
export const AI_PATH_TARGET_DRIFT = 96;
export const AI_PATH_WAYPOINT_RADIUS = 32;
