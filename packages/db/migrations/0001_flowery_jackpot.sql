ALTER TABLE `sessions` ADD `context_from_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `context_in_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `funding_tx` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `funding_confirmed_at` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `close_status` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `end_reason` text;