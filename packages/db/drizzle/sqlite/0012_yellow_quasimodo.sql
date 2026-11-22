CREATE TABLE `extension_files` (
	`id` text PRIMARY KEY NOT NULL,
	`extension_id` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`status` text NOT NULL,
	`collection` text,
	`key` text,
	`data` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_extension_files_id_ulid" CHECK(length("extension_files"."id") = 26),
	CONSTRAINT "ck_extension_files_extension_id_ulid" CHECK(length("extension_files"."extension_id") = 26),
	CONSTRAINT "ck_extension_files_status" CHECK("extension_files"."status" in ('pending', 'kept'))
);
--> statement-breakpoint
CREATE INDEX `ix_extension_files_item` ON `extension_files` (`extension_id`,`collection`,`key`);--> statement-breakpoint
CREATE INDEX `ix_extension_files_status` ON `extension_files` (`status`,`created_at`);