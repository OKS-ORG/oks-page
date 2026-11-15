CREATE TABLE "known_devices" (
	"user_id" text NOT NULL,
	"device_hash" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "known_devices_user_id_device_hash_pk" PRIMARY KEY("user_id","device_hash"),
	CONSTRAINT "ck_known_devices_user_id_ulid" CHECK (length("known_devices"."user_id") = 26)
);
--> statement-breakpoint
ALTER TABLE "known_devices" ADD CONSTRAINT "known_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;