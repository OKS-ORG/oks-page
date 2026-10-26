CREATE TABLE "extension_pending_updates" (
	"extension_id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"code" text NOT NULL,
	"integrity" text NOT NULL,
	"new_permissions" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "ck_extension_pending_updates_extension_id_ulid" CHECK (length("extension_pending_updates"."extension_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "extension_previous_versions" (
	"extension_id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"code" text NOT NULL,
	"integrity" text NOT NULL,
	"replaced_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "ck_extension_previous_versions_extension_id_ulid" CHECK (length("extension_previous_versions"."extension_id") = 26)
);
--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "integrity" text;--> statement-breakpoint
ALTER TABLE "extension_pending_updates" ADD CONSTRAINT "extension_pending_updates_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_previous_versions" ADD CONSTRAINT "extension_previous_versions_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;