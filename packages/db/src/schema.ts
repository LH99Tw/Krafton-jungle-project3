import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const matchMode = pgEnum("match_mode", ["prototype", "full"]);
export const matchDifficulty = pgEnum("match_difficulty", ["easy", "normal", "hard"]);
export const matchState = pgEnum("match_state", [
  "running",
  "victory",
  "defeat",
  "abandoned",
  "server_error",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cognitoSub: text("cognito_sub").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("users_cognito_sub_unique").on(table.cognitoSub),
    check("users_display_name_length", sql`char_length(${table.displayName}) BETWEEN 1 AND 60`),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_sessions_token_hash_unique").on(table.tokenHash),
    index("auth_sessions_user_id_idx").on(table.userId),
    index("auth_sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const gameTicketNonces = pgTable(
  "game_ticket_nonces",
  {
    jti: text("jti").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    room: text("room").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("game_ticket_nonces_expires_at_idx").on(table.expiresAt),
    check("game_ticket_nonces_room", sql`${table.room} IN ('global_chat', 'lobby', 'party')`),
  ],
);

export const guestbookEntries = pgTable(
  "guestbook_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    content: text("content").notNull(),
    editPasswordHash: text("edit_password_hash"),
    positionX: integer("position_x").notNull().default(500),
    positionY: integer("position_y").notNull().default(500),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("guestbook_created_at_idx").on(table.createdAt),
    check("guestbook_content_length", sql`char_length(${table.content}) BETWEEN 2 AND 180`),
    check("guestbook_position_x_range", sql`${table.positionX} BETWEEN 0 AND 1000`),
    check("guestbook_position_y_range", sql`${table.positionY} BETWEEN 0 AND 1000`),
  ],
);

export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: text("room_id").notNull(),
    mode: matchMode("mode").notNull(),
    difficulty: matchDifficulty("difficulty").notNull(),
    state: matchState("state").notNull().default("running"),
    seed: text("seed").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    serverVersion: text("server_version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    day: integer("day").notNull().default(1),
    resultReason: text("result_reason"),
  },
  (table) => [
    uniqueIndex("matches_room_id_unique").on(table.roomId),
    index("matches_started_at_idx").on(table.startedAt),
    check("matches_day_range", sql`${table.day} BETWEEN 1 AND 5`),
  ],
);

export const matchPlayers = pgTable(
  "match_players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    heroClass: text("hero_class").notNull(),
    level: integer("level").notNull().default(1),
    teamPower: integer("team_power").notNull().default(0),
    damage: integer("damage").notNull().default(0),
    bossDamage: integer("boss_damage").notNull().default(0),
    kills: integer("kills").notNull().default(0),
    deaths: integer("deaths").notNull().default(0),
    structuresBuilt: integer("structures_built").notNull().default(0),
    gatesDestroyed: integer("gates_destroyed").notNull().default(0),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    disconnected: boolean("disconnected").notNull().default(false),
  },
  (table) => [
    uniqueIndex("match_players_match_user_unique").on(table.matchId, table.userId),
    index("match_players_user_joined_idx").on(table.userId, table.joinedAt),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(authSessions),
  guestbookEntries: many(guestbookEntries),
  matchPlayers: many(matchPlayers),
}));

export const matchesRelations = relations(matches, ({ many }) => ({
  players: many(matchPlayers),
}));
