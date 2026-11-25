CREATE TABLE "collect_items" (
	"id" text PRIMARY KEY NOT NULL,
	"link_id" text NOT NULL,
	"site_id" text NOT NULL,
	"kind" text NOT NULL,
	"sender" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"file_name" text,
	"mime" text,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"data" "bytea",
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "ck_collect_items_id_ulid" CHECK (length("collect_items"."id") = 26),
	CONSTRAINT "ck_collect_items_link_id_ulid" CHECK (length("collect_items"."link_id") = 26),
	CONSTRAINT "ck_collect_items_site_id_ulid" CHECK (length("collect_items"."site_id") = 26),
	CONSTRAINT "ck_collect_items_kind" CHECK ("collect_items"."kind" in ('text', 'file')),
	CONSTRAINT "ck_collect_items_status" CHECK ("collect_items"."status" in ('pending', 'accepted'))
);
--> statement-breakpoint
CREATE TABLE "collect_links" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"label" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"max_files" integer NOT NULL,
	"max_bytes" bigint NOT NULL,
	"max_text" integer NOT NULL,
	"disabled_at" timestamp (3) with time zone,
	"created_by" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "ck_collect_links_id_ulid" CHECK (length("collect_links"."id") = 26),
	CONSTRAINT "ck_collect_links_site_id_ulid" CHECK (length("collect_links"."site_id") = 26),
	CONSTRAINT "ck_collect_links_created_by_ulid" CHECK (length("collect_links"."created_by") = 26)
);
--> statement-breakpoint
ALTER TABLE "collect_items" ADD CONSTRAINT "collect_items_link_id_collect_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."collect_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collect_items" ADD CONSTRAINT "collect_items_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collect_links" ADD CONSTRAINT "collect_links_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collect_links" ADD CONSTRAINT "collect_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_collect_items_link" ON "collect_items" USING btree ("link_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_collect_items_site" ON "collect_items" USING btree ("site_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_collect_links_token" ON "collect_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_collect_links_site" ON "collect_links" USING btree ("site_id","created_at");