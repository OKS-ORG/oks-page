CREATE TABLE `consent_records` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`choice` text NOT NULL,
	`version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_consent_records_id_ulid" CHECK(length("consent_records"."id") = 26),
	CONSTRAINT "ck_consent_records_site_id_ulid" CHECK(length("consent_records"."site_id") = 26)
);
--> statement-breakpoint
CREATE INDEX `ix_consent_records_site` ON `consent_records` (`site_id`,`created_at`);