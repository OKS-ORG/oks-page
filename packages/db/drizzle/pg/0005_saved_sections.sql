CREATE TABLE "saved_section_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"section_id" text NOT NULL,
	"content" jsonb NOT NULL,
	"published_at" timestamp (3) with time zone NOT NULL,
	"published_by" text,
	CONSTRAINT "ck_saved_section_versions_id_ulid" CHECK (length("saved_section_versions"."id") = 26),
	CONSTRAINT "ck_saved_section_versions_section_id_ulid" CHECK (length("saved_section_versions"."section_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "saved_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"section_group" text DEFAULT 'other' NOT NULL,
	"content" jsonb NOT NULL,
	"draft" jsonb,
	"created_by" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "uq_saved_sections_site_id_name" UNIQUE("site_id","name"),
	CONSTRAINT "ck_saved_sections_id_ulid" CHECK (length("saved_sections"."id") = 26),
	CONSTRAINT "ck_saved_sections_site_id_ulid" CHECK (length("saved_sections"."site_id") = 26)
);
--> statement-breakpoint
ALTER TABLE "saved_section_versions" ADD CONSTRAINT "saved_section_versions_section_id_saved_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."saved_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_section_versions" ADD CONSTRAINT "saved_section_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_sections" ADD CONSTRAINT "saved_sections_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_sections" ADD CONSTRAINT "saved_sections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_saved_section_versions_section" ON "saved_section_versions" USING btree ("section_id","published_at");