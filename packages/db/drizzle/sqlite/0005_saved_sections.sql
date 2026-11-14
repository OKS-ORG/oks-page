CREATE TABLE `saved_section_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`section_id` text NOT NULL,
	`content` text NOT NULL,
	`published_at` integer NOT NULL,
	`published_by` text,
	FOREIGN KEY (`section_id`) REFERENCES `saved_sections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`published_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_saved_section_versions_id_ulid" CHECK(length("saved_section_versions"."id") = 26),
	CONSTRAINT "ck_saved_section_versions_section_id_ulid" CHECK(length("saved_section_versions"."section_id") = 26),
	CONSTRAINT "ck_saved_section_versions_content_json" CHECK(json_valid("saved_section_versions"."content"))
);
--> statement-breakpoint
CREATE INDEX `ix_saved_section_versions_section` ON `saved_section_versions` (`section_id`,`published_at`);--> statement-breakpoint
CREATE TABLE `saved_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`section_group` text DEFAULT 'other' NOT NULL,
	`content` text NOT NULL,
	`draft` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_saved_sections_id_ulid" CHECK(length("saved_sections"."id") = 26),
	CONSTRAINT "ck_saved_sections_site_id_ulid" CHECK(length("saved_sections"."site_id") = 26),
	CONSTRAINT "ck_saved_sections_content_json" CHECK(json_valid("saved_sections"."content")),
	CONSTRAINT "ck_saved_sections_draft_json" CHECK("saved_sections"."draft" is null or json_valid("saved_sections"."draft"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_saved_sections_site_id_name` ON `saved_sections` (`site_id`,`name`);