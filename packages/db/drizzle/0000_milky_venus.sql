CREATE TYPE "public"."match_difficulty" AS ENUM('easy', 'normal', 'hard');--> statement-breakpoint
CREATE TYPE "public"."match_mode" AS ENUM('prototype', 'full');--> statement-breakpoint
CREATE TYPE "public"."match_state" AS ENUM('running', 'victory', 'defeat', 'abandoned', 'server_error');--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"encrypted_refresh_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guestbook_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid,
	"author_name" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guestbook_content_length" CHECK (char_length("guestbook_entries"."content") BETWEEN 2 AND 180)
);
--> statement-breakpoint
CREATE TABLE "match_players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"hero_class" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"team_power" integer DEFAULT 0 NOT NULL,
	"damage" integer DEFAULT 0 NOT NULL,
	"boss_damage" integer DEFAULT 0 NOT NULL,
	"kills" integer DEFAULT 0 NOT NULL,
	"deaths" integer DEFAULT 0 NOT NULL,
	"structures_built" integer DEFAULT 0 NOT NULL,
	"gold_spent" integer DEFAULT 0 NOT NULL,
	"gates_destroyed" integer DEFAULT 0 NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"disconnected" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" text NOT NULL,
	"mode" "match_mode" NOT NULL,
	"difficulty" "match_difficulty" NOT NULL,
	"state" "match_state" DEFAULT 'running' NOT NULL,
	"seed" text NOT NULL,
	"protocol_version" integer NOT NULL,
	"server_version" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"day" integer DEFAULT 1 NOT NULL,
	"result_reason" text,
	CONSTRAINT "matches_day_range" CHECK ("matches"."day" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cognito_sub" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_display_name_length" CHECK (char_length("users"."display_name") BETWEEN 1 AND 60)
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guestbook_entries" ADD CONSTRAINT "guestbook_entries_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_hash_unique" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "guestbook_created_at_idx" ON "guestbook_entries" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "match_players_match_user_unique" ON "match_players" USING btree ("match_id","user_id");--> statement-breakpoint
CREATE INDEX "match_players_user_joined_idx" ON "match_players" USING btree ("user_id","joined_at");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_room_id_unique" ON "matches" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "matches_started_at_idx" ON "matches" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_cognito_sub_unique" ON "users" USING btree ("cognito_sub");