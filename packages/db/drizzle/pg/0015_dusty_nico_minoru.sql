CREATE TABLE "consent_records" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"choice" text NOT NULL,
	"version" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "ck_consent_records_id_ulid" CHECK (length("consent_records"."id") = 26),
	CONSTRAINT "ck_consent_records_site_id_ulid" CHECK (length("consent_records"."site_id") = 26)
);
--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_consent_records_site" ON "consent_records" USING btree ("site_id","created_at");