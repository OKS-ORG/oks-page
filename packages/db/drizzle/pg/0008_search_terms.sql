CREATE TABLE "search_terms" (
	"site_id" text NOT NULL,
	"term" text NOT NULL,
	"day" text NOT NULL,
	"searches" integer DEFAULT 0 NOT NULL,
	"no_results" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "search_terms_site_id_term_day_pk" PRIMARY KEY("site_id","term","day"),
	CONSTRAINT "ck_search_terms_site_id_ulid" CHECK (length("search_terms"."site_id") = 26)
);
--> statement-breakpoint
ALTER TABLE "search_terms" ADD CONSTRAINT "search_terms_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_search_terms_day" ON "search_terms" USING btree ("site_id","day");