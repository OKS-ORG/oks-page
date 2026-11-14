CREATE TABLE `email_log` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`email_key` text NOT NULL,
	`to_address` text NOT NULL,
	`subject` text NOT NULL,
	`provider` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_attempt_at` integer,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_email_log_id_ulid" CHECK(length("email_log"."id") = 26),
	CONSTRAINT "ck_email_log_site_id_ulid" CHECK(length("email_log"."site_id") = 26),
	CONSTRAINT "ck_email_log_status" CHECK("email_log"."status" in ('queued', 'sent', 'retrying', 'failed', 'dropped'))
);
--> statement-breakpoint
CREATE INDEX `ix_email_log_time` ON `email_log` (`site_id`,`created_at`);