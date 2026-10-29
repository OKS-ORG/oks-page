CREATE TABLE "extension_settings" (
	"extension_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "extension_settings_extension_id_key_pk" PRIMARY KEY("extension_id","key"),
	CONSTRAINT "ck_extension_settings_extension_id_ulid" CHECK (length("extension_settings"."extension_id") = 26)
);
--> statement-breakpoint
ALTER TABLE "extension_settings" ADD CONSTRAINT "extension_settings_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;