CREATE TABLE "privacy_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"email_hash" text NOT NULL,
	"email_sealed" text,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"confirmed_at" timestamp (3) with time zone,
	"done_at" timestamp (3) with time zone,
	CONSTRAINT "ck_privacy_requests_id_ulid" CHECK (length("privacy_requests"."id") = 26),
	CONSTRAINT "ck_privacy_requests_site_id_ulid" CHECK (length("privacy_requests"."site_id") = 26),
	CONSTRAINT "ck_privacy_requests_kind" CHECK ("privacy_requests"."kind" in ('export', 'delete')),
	CONSTRAINT "ck_privacy_requests_status" CHECK ("privacy_requests"."status" in ('pending', 'confirmed', 'answered'))
);
--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_privacy_requests_token" ON "privacy_requests" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_privacy_requests_site" ON "privacy_requests" USING btree ("site_id","status","created_at");--> statement-breakpoint
CREATE INDEX "ix_privacy_requests_address" ON "privacy_requests" USING btree ("site_id","email_hash","created_at");