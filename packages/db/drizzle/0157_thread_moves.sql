CREATE TABLE IF NOT EXISTS `thread_moves` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`source_environment_id` text NOT NULL,
	`target_environment_id` text NOT NULL,
	`source_host_id` text NOT NULL,
	`target_host_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_thread_id` text NOT NULL,
	`source_cwd` text NOT NULL,
	`target_cwd` text NOT NULL,
	`phase` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `thread_moves_unfinished_thread_idx` ON `thread_moves` (`thread_id`) WHERE "thread_moves"."phase" NOT IN ('done', 'failed', 'cleanup_pending', 'rolled_back');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `thread_moves_thread_idx` ON `thread_moves` (`thread_id`);