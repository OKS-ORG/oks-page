CREATE TABLE `privacy_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`email_hash` text NOT NULL,
	`email_sealed` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`confirmed_at` integer,
	`done_at` integer,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_privacy_requests_id_ulid" CHECK(length("privacy_requests"."id") = 26),
	CONSTRAINT "ck_privacy_requests_site_id_ulid" CHECK(length("privacy_requests"."site_id") = 26),
	CONSTRAINT "ck_privacy_requests_kind" CHECK("privacy_requests"."kind" in ('export', 'delete')),
	CONSTRAINT "ck_privacy_requests_status" CHECK("privacy_requests"."status" in ('pending', 'confirmed', 'answered'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_privacy_requests_token` ON `privacy_requests` (`token_hash`);--> statement-breakpoint
CREATE INDEX `ix_privacy_requests_site` ON `privacy_requests` (`site_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_privacy_requests_address` ON `privacy_requests` (`site_id`,`email_hash`,`created_at`);