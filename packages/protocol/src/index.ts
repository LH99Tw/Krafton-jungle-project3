import { z } from "zod";

export const PROTOCOL_VERSION = 3;
export const PARTY_ROOM = "party_room";
export const LOBBY_ROOM = "lobby_room";
export const GLOBAL_CHAT_ROOM = "global_chat";
export const gameTicketRoomSchema = z.enum(["global_chat", "lobby", "party"]);

const unsafeTextPattern = /[<>\u0000-\u001f\u007f]/u;

export function normalizePublicText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function isSafePublicText(value: string): boolean {
  return !unsafeTextPattern.test(value);
}

const publicText = (minimum: number, maximum: number) => z.string()
  .transform(normalizePublicText)
  .pipe(z.string().min(minimum).max(maximum).refine(isSafePublicText, "unsafe public text"));

export const heroClassSchema = z.enum(["swordsman", "archer", "mage"]);
export const sessionModeSchema = z.enum(["prototype", "full"]);
export const difficultySchema = z.enum(["easy", "normal", "hard"]);
export const partyModeSchema = z.enum(["solo", "coop"]);
export const networkIdSchema = z.string().trim().min(1).max(96);

export const roomOptionsSchema = z.object({
  heroClass: heroClassSchema,
  sessionMode: sessionModeSchema.default("prototype"),
  difficulty: difficultySchema.default("normal"),
  partyMode: partyModeSchema.default("coop"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});

export const lobbyPhaseSchema = z.enum(["waiting", "selecting", "in_game"]);
export const lobbyCreateOptionsSchema = z.object({
  roomName: publicText(2, 24),
  sessionMode: sessionModeSchema.default("prototype"),
  difficulty: difficultySchema.default("normal"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export const lobbyReadySchema = z.object({ ready: z.boolean() });
export const lobbyClassSelectSchema = z.object({ heroClass: heroClassSchema.nullable() });
export const lobbyChatSchema = z.object({ message: publicText(1, 180) });
export const lobbyAiRemoveSchema = z.object({ userId: z.string().startsWith("ai:") });

export const commandEnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  clientTime: z.number().finite().nonnegative(),
}).strict();

const envelope = commandEnvelopeSchema.shape;

export const playerInputSchema = z.object({
  ...envelope,
  type: z.literal("player.input"),
  payload: z.object({
    x: z.number().finite().min(-1).max(1),
    y: z.number().finite().min(-1).max(1),
    aim: z.number().finite().min(-Math.PI * 2).max(Math.PI * 2),
    buttons: z.number().int().nonnegative().max(31),
  }).strict(),
}).strict();

export const inputFrameSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  clientTime: z.number().finite().nonnegative(),
  x: z.number().finite().min(-1).max(1),
  y: z.number().finite().min(-1).max(1),
  aim: z.number().finite().min(-Math.PI * 2).max(Math.PI * 2),
  buttons: z.number().int().nonnegative().max(31),
}).strict();

export const transformFlags = {
  none: 0,
  discontinuity: 1,
} as const;

export const transformSampleSchema = z.object({
  id: networkIdSchema,
  roomId: networkIdSchema,
  x: z.number().finite(),
  y: z.number().finite(),
  vx: z.number().finite(),
  vy: z.number().finite(),
  aim: z.number().finite(),
  flags: z.number().int().nonnegative().max(255),
}).strict();

export const worldFrameSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  serverTick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  serverTime: z.number().int().nonnegative(),
  ackInputSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  players: z.array(transformSampleSchema).max(3),
  enemies: z.array(transformSampleSchema).max(512),
}).strict();

export const fastLaneOfferSchema = z.object({
  url: z.string().url().refine((value) => value.startsWith("https://"), "fast lane requires HTTPS"),
  token: z.string().min(32).max(2048),
  expiresAt: z.number().int().positive(),
}).strict();

export const transportModeSchema = z.enum(["webtransport", "websocket-fallback"]);

export const skillCastSchema = z.object({
  ...envelope,
  type: z.literal("skill.cast"),
  payload: z.object({
    skillId: z.enum(["q", "e", "dash"]),
    targetX: z.number().finite().min(0).max(1280),
    targetY: z.number().finite().min(0).max(720),
  }).strict(),
}).strict();

export const buildPlaceSchema = z.object({
  ...envelope,
  type: z.literal("build.place"),
  payload: z.object({
    buildingId: z.enum(["turret", "wall"]),
    gridX: z.number().int().min(0).max(24),
    gridY: z.number().int().min(0).max(16),
  }).strict(),
}).strict();

export const buildUpgradeSchema = z.object({
  ...envelope,
  type: z.literal("build.upgrade"),
  payload: z.object({ structureId: z.string().uuid() }).strict(),
}).strict();

export const upgradeChooseSchema = z.object({
  ...envelope,
  type: z.literal("upgrade.choose"),
  payload: z.object({
    draftId: networkIdSchema,
    upgradeId: z.string().min(1).max(64),
  }).strict(),
}).strict();

export const roomReadySchema = z.object({
  ...envelope,
  type: z.literal("room.ready"),
  payload: z.object({ ready: z.boolean() }).strict(),
}).strict();

export const playerInteractSchema = z.object({
  ...envelope,
  type: z.literal("player.interact"),
  payload: z.object({ targetId: networkIdSchema }).strict(),
}).strict();

export const travelRequestSchema = z.object({
  ...envelope,
  type: z.literal("travel.request"),
  payload: z.object({
    waypointId: networkIdSchema,
    destinationId: networkIdSchema,
  }).strict(),
}).strict();

export const recallRequestSchema = z.object({
  ...envelope,
  type: z.literal("recall.request"),
  payload: z.object({}).strict(),
}).strict();

export const equipmentEquipSchema = z.object({
  ...envelope,
  type: z.literal("equipment.equip"),
  payload: z.object({ dropId: networkIdSchema }).strict(),
}).strict();

export const clientCommandSchema = z.discriminatedUnion("type", [
  playerInputSchema,
  skillCastSchema,
  buildPlaceSchema,
  buildUpgradeSchema,
  upgradeChooseSchema,
  roomReadySchema,
  playerInteractSchema,
  travelRequestSchema,
  recallRequestSchema,
  equipmentEquipSchema,
]);

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type PlayerInputCommand = z.infer<typeof playerInputSchema>;
export type InputFrame = z.infer<typeof inputFrameSchema>;
export type TransformSample = z.infer<typeof transformSampleSchema>;
export type WorldFrame = z.infer<typeof worldFrameSchema>;
export type FastLaneOffer = z.infer<typeof fastLaneOfferSchema>;
export type TransportMode = z.infer<typeof transportModeSchema>;
export type SkillCastCommand = z.infer<typeof skillCastSchema>;
export type BuildPlaceCommand = z.infer<typeof buildPlaceSchema>;
export type BuildUpgradeCommand = z.infer<typeof buildUpgradeSchema>;
export type UpgradeChooseCommand = z.infer<typeof upgradeChooseSchema>;
export type RoomReadyCommand = z.infer<typeof roomReadySchema>;
export type PlayerInteractCommand = z.infer<typeof playerInteractSchema>;
export type TravelRequestCommand = z.infer<typeof travelRequestSchema>;
export type RecallRequestCommand = z.infer<typeof recallRequestSchema>;
export type EquipmentEquipCommand = z.infer<typeof equipmentEquipSchema>;
export type RoomOptionsInput = z.input<typeof roomOptionsSchema>;
export type ResolvedRoomOptions = z.output<typeof roomOptionsSchema>;
// `partyMode` remains optional at existing call sites while the parser resolves it to "coop".
export type RoomOptions = Omit<ResolvedRoomOptions, "partyMode"> & { partyMode?: PartyMode };
export type HeroClassId = z.infer<typeof heroClassSchema>;
export type SessionMode = z.infer<typeof sessionModeSchema>;
export type Difficulty = z.infer<typeof difficultySchema>;
export type PartyMode = z.infer<typeof partyModeSchema>;
export type GameTicketRoom = z.infer<typeof gameTicketRoomSchema>;
export type LobbyPhase = z.infer<typeof lobbyPhaseSchema>;
export type LobbyCreateOptions = z.infer<typeof lobbyCreateOptionsSchema>;
export type LobbyListing = {
  roomId: string;
  roomName: string;
  clients: number;
  maxClients: 3;
  phase: LobbyPhase;
  sessionMode: SessionMode;
  difficulty: Difficulty;
};
export type LobbyChatMessage = {
  id: string;
  userId: string;
  displayName: string;
  message: string;
  sentAt: number;
};
export type LobbyGameStart = {
  gameRoomId: string;
  sessionMode: SessionMode;
  difficulty: Difficulty;
  playerClasses: Record<string, HeroClassId>;
};

export type ServerEvent =
  | { type: "message"; message: string }
  | { type: "result"; state: "victory" | "defeat" | "abandoned"; reason: string }
  | { type: "protocol-error"; code: string };
