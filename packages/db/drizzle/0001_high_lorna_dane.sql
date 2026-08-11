CREATE TABLE "game_ticket_nonces" (
	"jti" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"room" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_ticket_nonces_room" CHECK ("game_ticket_nonces"."room" IN ('global_chat', 'lobby', 'party'))
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ALTER COLUMN "encrypted_refresh_token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "game_ticket_nonces" ADD CONSTRAINT "game_ticket_nonces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_ticket_nonces_expires_at_idx" ON "game_ticket_nonces" USING btree ("expires_at");