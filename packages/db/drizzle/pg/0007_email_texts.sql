CREATE TABLE "email_texts" (
	"site_id" text NOT NULL,
	"email_key" text NOT NULL,
	"locale" text DEFAULT '' NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "email_texts_site_id_email_key_locale_pk" PRIMARY KEY("site_id","email_key","locale"),
	CONSTRAINT "ck_email_texts_site_id_ulid" CHECK (length("email_texts"."site_id") = 26)
);
--> statement-breakpoint
ALTER TABLE "email_texts" ADD CONSTRAINT "email_texts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_texts" ADD CONSTRAINT "email_texts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;