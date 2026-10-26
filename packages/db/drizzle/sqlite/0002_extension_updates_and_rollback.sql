CREATE TABLE `extension_pending_updates` (
	`extension_id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`code` text NOT NULL,
	`integrity` text NOT NULL,
	`new_permissions` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_extension_pending_updates_extension_id_ulid" CHECK(length("extension_pending_updates"."extension_id") = 26),
	CONSTRAINT "ck_extension_pending_updates_new_permissions_json" CHECK(json_valid("extension_pending_updates"."new_permissions"))
);
--> statement-breakpoint
CREATE TABLE `extension_previous_versions` (
	`extension_id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`code` text NOT NULL,
	`integrity` text NOT NULL,
	`replaced_at` integer NOT NULL,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_extension_previous_versions_extension_id_ulid" CHECK(length("extension_previous_versions"."extension_id") = 26)
);
--> statement-breakpoint
ALTER TABLE `extensions` ADD `code` text;--> statement-breakpoint
ALTER TABLE `extensions` ADD `integrity` text;