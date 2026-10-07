CREATE TABLE `agent_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`service_id` text NOT NULL,
	`external_job_id` text,
	`input` text NOT NULL,
	`price_micro` text NOT NULL,
	`payment_id` text,
	`status` text NOT NULL,
	`result` text,
	`result_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`requested_by` text NOT NULL,
	`ref_key` text NOT NULL,
	`details_json` text NOT NULL,
	`status` text NOT NULL,
	`open_key` text,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_open_key` ON `decisions` (`open_key`);--> statement-breakpoint
CREATE INDEX `decisions_session` ON `decisions` (`session_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`goal_id` text,
	`session_id` text,
	`data_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_goal` ON `events` (`goal_id`);--> statement-breakpoint
CREATE INDEX `events_session` ON `events` (`session_id`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`goal` text NOT NULL,
	`budget_micro` text NOT NULL,
	`deadline` integer NOT NULL,
	`rules` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`plan_json` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`funding_tx` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `keys` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`path` text NOT NULL,
	`key_hash` text NOT NULL,
	`ciphertext` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`from` text NOT NULL,
	`text` text NOT NULL,
	`delivered_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_session` ON `messages` (`session_id`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`payee` text NOT NULL,
	`amount_micro` text NOT NULL,
	`memo` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`rejection_reason` text,
	`tx_hash` text,
	`fee_lovelace` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`user_id` text NOT NULL,
	`parent_session_id` text,
	`letter` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`agent_type` text NOT NULL,
	`task_type` text NOT NULL,
	`allow_web_fetch` integer DEFAULT false NOT NULL,
	`watch_json` text,
	`done_attempts` integer DEFAULT 0 NOT NULL,
	`goal` text NOT NULL,
	`status` text NOT NULL,
	`wallet_mode` text DEFAULT 'native' NOT NULL,
	`budget_micro` text NOT NULL,
	`per_payment_max_micro` text NOT NULL,
	`approval_threshold_micro` text NOT NULL,
	`allowed_payees_json` text NOT NULL,
	`expires_at` integer NOT NULL,
	`expiry_slot` integer,
	`data_scope_json` text DEFAULT '[]' NOT NULL,
	`key_index` integer NOT NULL,
	`session_key_hash` text,
	`script_cbor` text,
	`script_json` text,
	`address` text,
	`spent_micro` text DEFAULT '0' NOT NULL,
	`refund_micro` text,
	`fees_lovelace` text DEFAULT '0' NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`tainted` integer DEFAULT false NOT NULL,
	`handback_json` text,
	`handback_sha256` text,
	`log_sha256` text,
	`close_tx` text,
	`close_attempts` integer DEFAULT 0 NOT NULL,
	`last_checkpoint` text,
	`started_at` integer,
	`ended_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_goal` ON `sessions` (`goal_id`);--> statement-breakpoint
CREATE INDEX `sessions_status` ON `sessions` (`status`);--> statement-breakpoint
CREATE TABLE `topups` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`amount_myr` text NOT NULL,
	`fee_myr` text NOT NULL,
	`tusd_micro` text NOT NULL,
	`stripe_session_id` text,
	`stripe_event_id` text,
	`simulated` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`tx_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `topups_stripe_event` ON `topups` (`stripe_event_id`);--> statement-breakpoint
CREATE TABLE `transitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`reason` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`custody` text NOT NULL,
	`account_index` integer NOT NULL,
	`treasury_address` text NOT NULL,
	`owner_key_hash` text NOT NULL,
	`stake_key_hash` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);