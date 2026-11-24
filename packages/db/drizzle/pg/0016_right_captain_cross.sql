CREATE TABLE "stats_daily" (
	"site_id" text NOT NULL,
	"day" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "stats_daily_site_id_day_kind_key_pk" PRIMARY KEY("site_id","day","kind","key")
);
--> statement-breakpoint
CREATE TABLE "stats_seen" (
	"site_id" text NOT NULL,
	"day" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "stats_seen_site_id_day_hash_pk" PRIMARY KEY("site_id","day","hash")
);
--> statement-breakpoint
ALTER TABLE "stats_daily" ADD CONSTRAINT "stats_daily_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stats_seen" ADD CONSTRAINT "stats_seen_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;