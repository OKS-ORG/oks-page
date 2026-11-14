CREATE TABLE "email_log" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"email_key" text NOT NULL,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"last_attempt_at" timestamp (3) with time zone,
	CONSTRAINT "ck_email_log_id_ulid" CHECK (length("email_log"."id") = 26),
	CONSTRAINT "ck_email_log_site_id_ulid" CHECK (length("email_log"."site_id") = 26),
	CONSTRAINT "ck_email_log_status" CHECK ("email_log"."status" in ('queued', 'sent', 'retrying', 'failed', 'dropped'))
);
--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_email_log_time" ON "email_log" USING btree ("site_id","created_at");