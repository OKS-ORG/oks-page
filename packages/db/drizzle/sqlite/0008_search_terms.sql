CREATE TABLE `search_terms` (
	`site_id` text NOT NULL,
	`term` text NOT NULL,
	`day` text NOT NULL,
	`searches` integer DEFAULT 0 NOT NULL,
	`no_results` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`site_id`, `term`, `day`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_search_terms_site_id_ulid" CHECK(length("search_terms"."site_id") = 26)
);
--> statement-breakpoint
CREATE INDEX `ix_search_terms_day` ON `search_terms` (`site_id`,`day`);