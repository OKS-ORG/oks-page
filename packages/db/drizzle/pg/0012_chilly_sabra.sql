CREATE TABLE "extension_files" (
	"id" text PRIMARY KEY NOT NULL,
	"extension_id" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"status" text NOT NULL,
	"collection" text,
	"key" text,
	"data" "bytea" NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "ck_extension_files_id_ulid" CHECK (length("extension_files"."id") = 26),
	CONSTRAINT "ck_extension_files_extension_id_ulid" CHECK (length("extension_files"."extension_id") = 26),
	CONSTRAINT "ck_extension_files_status" CHECK ("extension_files"."status" in ('pending', 'kept'))
);
--> statement-breakpoint
ALTER TABLE "extension_files" ADD CONSTRAINT "extension_files_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_extension_files_item" ON "extension_files" USING btree ("extension_id","collection","key");--> statement-breakpoint
CREATE INDEX "ix_extension_files_status" ON "extension_files" USING btree ("status","created_at");