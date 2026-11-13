CREATE TABLE `theme_override_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`theme_id` text NOT NULL,
	`template_key` text NOT NULL,
	`content` text NOT NULL,
	`published_at` integer NOT NULL,
	`published_by` text,
	FOREIGN KEY (`theme_id`) REFERENCES `themes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`published_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_theme_override_versions_id_ulid" CHECK(length("theme_override_versions"."id") = 26),
	CONSTRAINT "ck_theme_override_versions_theme_id_ulid" CHECK(length("theme_override_versions"."theme_id") = 26),
	CONSTRAINT "ck_theme_override_versions_content_json" CHECK(json_valid("theme_override_versions"."content"))
);
--> statement-breakpoint
CREATE INDEX `ix_theme_override_versions_layout` ON `theme_override_versions` (`theme_id`,`template_key`,`published_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_theme_overrides` (
	`theme_id` text NOT NULL,
	`template_key` text NOT NULL,
	`content` text,
	`draft` text,
	`kind` text DEFAULT 'theme' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`base_hash` text NOT NULL,
	`base_version` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`theme_id`, `template_key`),
	FOREIGN KEY (`theme_id`) REFERENCES `themes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_theme_overrides_theme_id_ulid" CHECK(length("__new_theme_overrides"."theme_id") = 26),
	CONSTRAINT "ck_theme_overrides_content_json" CHECK("__new_theme_overrides"."content" is null or json_valid("__new_theme_overrides"."content")),
	CONSTRAINT "ck_theme_overrides_draft_json" CHECK("__new_theme_overrides"."draft" is null or json_valid("__new_theme_overrides"."draft")),
	CONSTRAINT "ck_theme_overrides_kind" CHECK("__new_theme_overrides"."kind" in ('theme', 'owner-made'))
);
--> statement-breakpoint
INSERT INTO `__new_theme_overrides`("theme_id", "template_key", "content", "draft", "kind", "name", "base_hash", "base_version", "updated_at") SELECT "theme_id", "template_key", "content", NULL, 'theme', '', "base_hash", "base_version", "updated_at" FROM `theme_overrides`;--> statement-breakpoint
DROP TABLE `theme_overrides`;--> statement-breakpoint
ALTER TABLE `__new_theme_overrides` RENAME TO `theme_overrides`;--> statement-breakpoint
PRAGMA foreign_keys=ON;