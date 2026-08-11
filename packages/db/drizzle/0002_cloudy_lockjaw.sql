ALTER TABLE "guestbook_entries" ADD COLUMN "position_x" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "guestbook_entries" ADD COLUMN "position_y" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "guestbook_entries" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "guestbook_entries" ADD CONSTRAINT "guestbook_position_x_range" CHECK ("guestbook_entries"."position_x" BETWEEN 0 AND 1000);--> statement-breakpoint
ALTER TABLE "guestbook_entries" ADD CONSTRAINT "guestbook_position_y_range" CHECK ("guestbook_entries"."position_y" BETWEEN 0 AND 1000);