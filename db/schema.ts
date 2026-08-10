import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const guestbookEntries = sqliteTable(
  "guestbook_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    authorId: text("author_id").notNull(),
    authorName: text("author_name").notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_guestbook_created_at").on(table.createdAt)],
);

export const runResults = sqliteTable(
  "run_results",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    result: text("result", { enum: ["victory", "defeat"] }).notNull(),
    reason: text("reason").notNull(),
    day: integer("day").notNull(),
    elapsedSeconds: integer("elapsed_seconds").notNull(),
    level: integer("level").notNull(),
    teamPower: integer("team_power").notNull(),
    damage: integer("damage").notNull().default(0),
    bossDamage: integer("boss_damage").notNull().default(0),
    kills: integer("kills").notNull().default(0),
    deaths: integer("deaths").notNull().default(0),
    structuresBuilt: integer("structures_built").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_run_results_user_created").on(table.userId, table.createdAt)],
);

