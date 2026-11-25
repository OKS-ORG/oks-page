CREATE TABLE `collect_items` (
	`id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`site_id` text NOT NULL,
	`kind` text NOT NULL,
	`sender` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`file_name` text,
	`mime` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`data` blob,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`link_id`) REFERENCES `collect_links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_collect_items_id_ulid" CHECK(length("collect_items"."id") = 26),
	CONSTRAINT "ck_collect_items_link_id_ulid" CHECK(length("collect_items"."link_id") = 26),
	CONSTRAINT "ck_collect_items_site_id_ulid" CHECK(length("collect_items"."site_id") = 26),
	CONSTRAINT "ck_collect_items_kind" CHECK("collect_items"."kind" in ('text', 'file')),
	CONSTRAINT "ck_collect_items_status" CHECK("collect_items"."status" in ('pending', 'accepted'))
);
--> statement-breakpoint
CREATE INDEX `ix_collect_items_link` ON `collect_items` (`link_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_collect_items_site` ON `collect_items` (`site_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `collect_links` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`expires_at` integer NOT NULL,
	`max_files` integer NOT NULL,
	`max_bytes` integer NOT NULL,
	`max_text` integer NOT NULL,
	`disabled_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_collect_links_id_ulid" CHECK(length("collect_links"."id") = 26),
	CONSTRAINT "ck_collect_links_site_id_ulid" CHECK(length("collect_links"."site_id") = 26),
	CONSTRAINT "ck_collect_links_created_by_ulid" CHECK(length("collect_links"."created_by") = 26)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_collect_links_token` ON `collect_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `ix_collect_links_site` ON `collect_links` (`site_id`,`created_at`);