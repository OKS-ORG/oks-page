CREATE TABLE `extension_settings` (
	`extension_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`is_secret` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`extension_id`, `key`),
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_extension_settings_extension_id_ulid" CHECK(length("extension_settings"."extension_id") = 26),
	CONSTRAINT "ck_extension_settings_value_json" CHECK(json_valid("extension_settings"."value"))
);
