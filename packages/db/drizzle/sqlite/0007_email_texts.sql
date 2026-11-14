CREATE TABLE `email_texts` (
	`site_id` text NOT NULL,
	`email_key` text NOT NULL,
	`locale` text DEFAULT '' NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `email_key`, `locale`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_email_texts_site_id_ulid" CHECK(length("email_texts"."site_id") = 26)
);
