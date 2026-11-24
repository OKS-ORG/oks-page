CREATE TABLE `stats_daily` (
	`site_id` text NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`site_id`, `day`, `kind`, `key`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `stats_seen` (
	`site_id` text NOT NULL,
	`day` text NOT NULL,
	`hash` text NOT NULL,
	PRIMARY KEY(`site_id`, `day`, `hash`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
