CREATE TABLE `guestbook_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` text NOT NULL,
	`author_name` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_guestbook_created_at` ON `guestbook_entries` (`created_at`);--> statement-breakpoint
CREATE TABLE `run_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`result` text NOT NULL,
	`reason` text NOT NULL,
	`day` integer NOT NULL,
	`elapsed_seconds` integer NOT NULL,
	`level` integer NOT NULL,
	`team_power` integer NOT NULL,
	`damage` integer DEFAULT 0 NOT NULL,
	`boss_damage` integer DEFAULT 0 NOT NULL,
	`kills` integer DEFAULT 0 NOT NULL,
	`deaths` integer DEFAULT 0 NOT NULL,
	`structures_built` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_run_results_user_created` ON `run_results` (`user_id`,`created_at`);