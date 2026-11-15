CREATE TABLE `known_devices` (
	`user_id` text NOT NULL,
	`device_hash` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `device_hash`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_known_devices_user_id_ulid" CHECK(length("known_devices"."user_id") = 26)
);
