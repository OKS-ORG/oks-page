CREATE TABLE `cache_tags` (
	`site_id` text NOT NULL,
	`tag` text NOT NULL,
	`stale_at` integer,
	`expired_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `tag`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_cache_tags_site_id_ulid" CHECK(length("cache_tags"."site_id") = 26)
);
--> statement-breakpoint
CREATE INDEX `ix_cache_tags_updated` ON `cache_tags` (`site_id`,`updated_at`);