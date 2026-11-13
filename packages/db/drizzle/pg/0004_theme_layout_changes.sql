CREATE TABLE "theme_override_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"theme_id" text NOT NULL,
	"template_key" text NOT NULL,
	"content" jsonb NOT NULL,
	"published_at" timestamp (3) with time zone NOT NULL,
	"published_by" text,
	CONSTRAINT "ck_theme_override_versions_id_ulid" CHECK (length("theme_override_versions"."id") = 26),
	CONSTRAINT "ck_theme_override_versions_theme_id_ulid" CHECK (length("theme_override_versions"."theme_id") = 26)
);
--> statement-breakpoint
ALTER TABLE "theme_overrides" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "theme_overrides" ADD COLUMN "draft" jsonb;--> statement-breakpoint
ALTER TABLE "theme_overrides" ADD COLUMN "kind" text DEFAULT 'theme' NOT NULL;--> statement-breakpoint
ALTER TABLE "theme_overrides" ADD COLUMN "name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "theme_override_versions" ADD CONSTRAINT "theme_override_versions_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theme_override_versions" ADD CONSTRAINT "theme_override_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_theme_override_versions_layout" ON "theme_override_versions" USING btree ("theme_id","template_key","published_at");--> statement-breakpoint
ALTER TABLE "theme_overrides" ADD CONSTRAINT "ck_theme_overrides_kind" CHECK ("theme_overrides"."kind" in ('theme', 'owner-made'));