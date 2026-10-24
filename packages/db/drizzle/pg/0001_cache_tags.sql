CREATE TABLE "cache_tags" (
	"site_id" text NOT NULL,
	"tag" text NOT NULL,
	"stale_at" timestamp (3) with time zone,
	"expired_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "cache_tags_site_id_tag_pk" PRIMARY KEY("site_id","tag"),
	CONSTRAINT "ck_cache_tags_site_id_ulid" CHECK (length("cache_tags"."site_id") = 26)
);
--> statement-breakpoint
ALTER TABLE "cache_tags" ADD CONSTRAINT "cache_tags_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_cache_tags_updated" ON "cache_tags" USING btree ("site_id","updated_at");