import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const PARTY_ROOM = "party_room";

export const heroClassSchema = z.enum(["swordsman", "archer", "mage"]);
export const sessionModeSchema = z.enum(["prototype", "full"]);
export const difficultySchema = z.enum(["easy", "normal", "hard"]);

export const roomOptionsSchema = z.object({
  heroClass: heroClassSchema,
  sessionMode: sessionModeSchema.default("prototype"),
  difficulty: difficultySchema.default("normal"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});

const envelope = {
  v: z.literal(PROTOCOL_VERSION),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  clientTime: z.number().finite().nonnegative(),
};

export const playerInputSchema = z.object({
  ...envelope,
  type: z.literal("player.input"),
  payload: z.object({
    x: z.number().finite().min(-1).max(1),
    y: z.number().finite().min(-1).max(1),
    aim: z.number().finite().min(-Math.PI * 2).max(Math.PI * 2),
    buttons: z.number().int().nonnegative().max(31),
  }),
});

export const skillCastSchema = z.object({
  ...envelope,
  type: z.literal("skill.cast"),
  payload: z.object({
    skillId: z.enum(["q", "e", "dash"]),
    targetX: z.number().finite().min(0).max(2560),
    targetY: z.number().finite().min(0).max(1600),
  }),
});

export const buildPlaceSchema = z.object({
  ...envelope,
  type: z.literal("build.place"),
  payload: z.object({
    buildingId: z.enum(["turret", "wall"]),
    gridX: z.number().int().min(0).max(24),
    gridY: z.number().int().min(0).max(16),
  }),
});

export const buildUpgradeSchema = z.object({
  ...envelope,
  type: z.literal("build.upgrade"),
  payload: z.object({ structureId: z.string().uuid() }),
});

export const upgradeChooseSchema = z.object({
  ...envelope,
  type: z.literal("upgrade.choose"),
  payload: z.object({
    draftId: z.string().uuid(),
    upgradeId: z.string().min(1).max(64),
  }),
});

export const roomReadySchema = z.object({
  ...envelope,
  type: z.literal("room.ready"),
  payload: z.object({ ready: z.boolean() }),
});

export const clientCommandSchema = z.discriminatedUnion("type", [
  playerInputSchema,
  skillCastSchema,
  buildPlaceSchema,
  buildUpgradeSchema,
  upgradeChooseSchema,
  roomReadySchema,
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type PlayerInputCommand = z.infer<typeof playerInputSchema>;
export type RoomOptions = z.infer<typeof roomOptionsSchema>;
export type HeroClassId = z.infer<typeof heroClassSchema>;

export type ServerEvent =
  | { type: "message"; message: string }
  | { type: "result"; state: "victory" | "defeat" | "abandoned"; reason: string }
  | { type: "protocol-error"; code: string };
