CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"last_used_at" timestamp (3) with time zone,
	"expires_at" timestamp (3) with time zone,
	"revoked_at" timestamp (3) with time zone,
	CONSTRAINT "uq_api_keys_key_hash" UNIQUE("key_hash"),
	CONSTRAINT "ck_api_keys_id_ulid" CHECK (length("api_keys"."id") = 26),
	CONSTRAINT "ck_api_keys_site_id_ulid" CHECK (length("api_keys"."site_id") = 26),
	CONSTRAINT "ck_api_keys_created_by_ulid" CHECK (length("api_keys"."created_by") = 26)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"detail" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "ck_audit_log_id_ulid" CHECK (length("audit_log"."id") = 26),
	CONSTRAINT "ck_audit_log_site_id_ulid" CHECK (length("audit_log"."site_id") = 26),
	CONSTRAINT "ck_audit_log_actor_type" CHECK ("audit_log"."actor_type" in ('user', 'plugin', 'system', 'api_key'))
);
--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp (3) with time zone,
	"refresh_token_expires_at" timestamp (3) with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "ck_auth_accounts_id_ulid" CHECK (length("auth_accounts"."id") = 26),
	CONSTRAINT "ck_auth_accounts_user_id_ulid" CHECK (length("auth_accounts"."user_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "uq_auth_sessions_token" UNIQUE("token"),
	CONSTRAINT "ck_auth_sessions_id_ulid" CHECK (length("auth_sessions"."id") = 26),
	CONSTRAINT "ck_auth_sessions_user_id_ulid" CHECK (length("auth_sessions"."user_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "ck_auth_verifications_id_ulid" CHECK (length("auth_verifications"."id") = 26)
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"parent_id" text,
	"author_user_id" text,
	"author_name" text NOT NULL,
	"author_email_hash" text,
	"content" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "ck_comments_id_ulid" CHECK (length("comments"."id") = 26),
	CONSTRAINT "ck_comments_site_id_ulid" CHECK (length("comments"."site_id") = 26),
	CONSTRAINT "ck_comments_entry_id_ulid" CHECK (length("comments"."entry_id") = 26),
	CONSTRAINT "ck_comments_parent_id_ulid" CHECK (length("comments"."parent_id") = 26),
	CONSTRAINT "ck_comments_author_user_id_ulid" CHECK (length("comments"."author_user_id") = 26),
	CONSTRAINT "ck_comments_status" CHECK ("comments"."status" in ('pending', 'approved', 'spam', 'trash'))
);
--> statement-breakpoint
CREATE TABLE "content_types" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"url_rule" text NOT NULL,
	"has_body" boolean DEFAULT true NOT NULL,
	"hierarchical" boolean DEFAULT false NOT NULL,
	"icon" text,
	"options" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "uq_content_types_site_id_key" UNIQUE("site_id","key"),
	CONSTRAINT "ck_content_types_id_ulid" CHECK (length("content_types"."id") = 26),
	CONSTRAINT "ck_content_types_site_id_ulid" CHECK (length("content_types"."site_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"type_key" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"author_id" text NOT NULL,
	"parent_id" text,
	"locale" text DEFAULT '' NOT NULL,
	"fields" jsonb NOT NULL,
	"body" jsonb NOT NULL,
	"plain_text" text DEFAULT '' NOT NULL,
	"html" text DEFAULT '' NOT NULL,
	"seo" jsonb NOT NULL,
	"meta" jsonb NOT NULL,
	"published_at" timestamp (3) with time zone,
	"scheduled_at" timestamp (3) with time zone,
	"trashed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "ck_entries_id_ulid" CHECK (length("entries"."id") = 26),
	CONSTRAINT "ck_entries_site_id_ulid" CHECK (length("entries"."site_id") = 26),
	CONSTRAINT "ck_entries_status" CHECK ("entries"."status" in ('draft', 'pending', 'scheduled', 'published', 'private', 'trash')),
	CONSTRAINT "ck_entries_author_id_ulid" CHECK (length("entries"."author_id") = 26),
	CONSTRAINT "ck_entries_parent_id_ulid" CHECK (length("entries"."parent_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "entry_locks" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "ck_entry_locks_entry_id_ulid" CHECK (length("entry_locks"."entry_id") = 26),
	CONSTRAINT "ck_entry_locks_user_id_ulid" CHECK (length("entry_locks"."user_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "entry_media" (
	"entry_id" text NOT NULL,
	"media_id" text NOT NULL,
	"field" text NOT NULL,
	CONSTRAINT "entry_media_entry_id_media_id_field_pk" PRIMARY KEY("entry_id","media_id","field"),
	CONSTRAINT "ck_entry_media_entry_id_ulid" CHECK (length("entry_media"."entry_id") = 26),
	CONSTRAINT "ck_entry_media_media_id_ulid" CHECK (length("entry_media"."media_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "entry_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"kind" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"author_id" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "ck_entry_revisions_id_ulid" CHECK (length("entry_revisions"."id") = 26),
	CONSTRAINT "ck_entry_revisions_entry_id_ulid" CHECK (length("entry_revisions"."entry_id") = 26),
	CONSTRAINT "ck_entry_revisions_kind" CHECK ("entry_revisions"."kind" in ('revision', 'autosave')),
	CONSTRAINT "ck_entry_revisions_author_id_ulid" CHECK (length("entry_revisions"."author_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "entry_terms" (
	"entry_id" text NOT NULL,
	"term_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "entry_terms_entry_id_term_id_pk" PRIMARY KEY("entry_id","term_id"),
	CONSTRAINT "ck_entry_terms_entry_id_ulid" CHECK (length("entry_terms"."entry_id") = 26),
	CONSTRAINT "ck_entry_terms_term_id_ulid" CHECK (length("entry_terms"."term_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "extension_permissions" (
	"extension_id" text NOT NULL,
	"permission" text NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "extension_permissions_extension_id_permission_pk" PRIMARY KEY("extension_id","permission"),
	CONSTRAINT "ck_extension_permissions_extension_id_ulid" CHECK (length("extension_permissions"."extension_id") = 26),
	CONSTRAINT "ck_extension_permissions_granted_by_ulid" CHECK (length("extension_permissions"."granted_by") = 26)
);
--> statement-breakpoint
CREATE TABLE "extension_storage" (
	"extension_id" text NOT NULL,
	"collection" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"size_bytes" bigint NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "extension_storage_extension_id_collection_key_pk" PRIMARY KEY("extension_id","collection","key"),
	CONSTRAINT "ck_extension_storage_extension_id_ulid" CHECK (length("extension_storage"."extension_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "extensions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"version" text NOT NULL,
	"tier" text NOT NULL,
	"status" text DEFAULT 'enabled' NOT NULL,
	"license_key_hash" text,
	"installed_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "uq_extensions_site_id_key" UNIQUE("site_id","key"),
	CONSTRAINT "ck_extensions_id_ulid" CHECK (length("extensions"."id") = 26),
	CONSTRAINT "ck_extensions_site_id_ulid" CHECK (length("extensions"."site_id") = 26),
	CONSTRAINT "ck_extensions_kind" CHECK ("extensions"."kind" in ('plugin', 'theme')),
	CONSTRAINT "ck_extensions_tier" CHECK ("extensions"."tier" in ('runtime', 'build')),
	CONSTRAINT "ck_extensions_status" CHECK ("extensions"."status" in ('enabled', 'disabled', 'switched_off'))
);
--> statement-breakpoint
CREATE TABLE "field_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"content_type_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"field_type" text NOT NULL,
	"validation" jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"is_sortable" boolean DEFAULT false NOT NULL,
	"is_filterable" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "uq_field_definitions_content_type_id_key" UNIQUE("content_type_id","key"),
	CONSTRAINT "ck_field_definitions_id_ulid" CHECK (length("field_definitions"."id") = 26),
	CONSTRAINT "ck_field_definitions_content_type_id_ulid" CHECK (length("field_definitions"."content_type_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"run_at" timestamp (3) with time zone NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp (3) with time zone,
	"last_error" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"finished_at" timestamp (3) with time zone,
	CONSTRAINT "ck_jobs_id_ulid" CHECK (length("jobs"."id") = 26),
	CONSTRAINT "ck_jobs_site_id_ulid" CHECK (length("jobs"."site_id") = 26),
	CONSTRAINT "ck_jobs_status" CHECK ("jobs"."status" in ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"folder_id" text,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"alt" text DEFAULT '' NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"focal_x" double precision,
	"focal_y" double precision,
	"blur_placeholder" text,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "uq_media_site_id_storage_key" UNIQUE("site_id","storage_key"),
	CONSTRAINT "ck_media_id_ulid" CHECK (length("media"."id") = 26),
	CONSTRAINT "ck_media_site_id_ulid" CHECK (length("media"."site_id") = 26),
	CONSTRAINT "ck_media_folder_id_ulid" CHECK (length("media"."folder_id") = 26),
	CONSTRAINT "ck_media_status" CHECK ("media"."status" in ('processing', 'ready', 'failed')),
	CONSTRAINT "ck_media_uploaded_by_ulid" CHECK (length("media"."uploaded_by") = 26)
);
--> statement-breakpoint
CREATE TABLE "media_folders" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	CONSTRAINT "ck_media_folders_id_ulid" CHECK (length("media_folders"."id") = 26),
	CONSTRAINT "ck_media_folders_site_id_ulid" CHECK (length("media_folders"."site_id") = 26),
	CONSTRAINT "ck_media_folders_parent_id_ulid" CHECK (length("media_folders"."parent_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "media_variants" (
	"media_id" text NOT NULL,
	"width" integer NOT NULL,
	"format" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	CONSTRAINT "media_variants_media_id_width_format_pk" PRIMARY KEY("media_id","width","format"),
	CONSTRAINT "ck_media_variants_media_id_ulid" CHECK (length("media_variants"."media_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "menus" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"items" jsonb NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "uq_menus_site_id_key" UNIQUE("site_id","key"),
	CONSTRAINT "ck_menus_id_ulid" CHECK (length("menus"."id") = 26),
	CONSTRAINT "ck_menus_site_id_ulid" CHECK (length("menus"."site_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "not_found_log" (
	"site_id" text NOT NULL,
	"path" text NOT NULL,
	"hits" integer DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "not_found_log_site_id_path_pk" PRIMARY KEY("site_id","path"),
	CONSTRAINT "ck_not_found_log_site_id_ulid" CHECK (length("not_found_log"."site_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"aaguid" text,
	"created_at" timestamp (3) with time zone,
	CONSTRAINT "uq_passkeys_credential_id" UNIQUE("credential_id"),
	CONSTRAINT "ck_passkeys_id_ulid" CHECK (length("passkeys"."id") = 26),
	CONSTRAINT "ck_passkeys_user_id_ulid" CHECK (length("passkeys"."user_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request_ms" bigint NOT NULL,
	CONSTRAINT "uq_rate_limits_key" UNIQUE("key"),
	CONSTRAINT "ck_rate_limits_id_ulid" CHECK (length("rate_limits"."id") = 26)
);
--> statement-breakpoint
CREATE TABLE "redirects" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"from_path" text NOT NULL,
	"to_path" text NOT NULL,
	"status_code" integer DEFAULT 301 NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "uq_redirects_site_id_from_path" UNIQUE("site_id","from_path"),
	CONSTRAINT "ck_redirects_id_ulid" CHECK (length("redirects"."id") = 26),
	CONSTRAINT "ck_redirects_site_id_ulid" CHECK (length("redirects"."site_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "role_capabilities" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"capability" text NOT NULL,
	"scope_type_key" text DEFAULT '' NOT NULL,
	CONSTRAINT "uq_role_capabilities_role_id_capability_scope_type_key" UNIQUE("role_id","capability","scope_type_key"),
	CONSTRAINT "ck_role_capabilities_id_ulid" CHECK (length("role_capabilities"."id") = 26),
	CONSTRAINT "ck_role_capabilities_role_id_ulid" CHECK (length("role_capabilities"."role_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "uq_roles_site_id_key" UNIQUE("site_id","key"),
	CONSTRAINT "ck_roles_id_ulid" CHECK (length("roles"."id") = 26),
	CONSTRAINT "ck_roles_site_id_ulid" CHECK (length("roles"."site_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"site_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "settings_site_id_key_pk" PRIMARY KEY("site_id","key"),
	CONSTRAINT "ck_settings_site_id_ulid" CHECK (length("settings"."site_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "site_members" (
	"site_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role_id" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "site_members_site_id_user_id_pk" PRIMARY KEY("site_id","user_id"),
	CONSTRAINT "ck_site_members_site_id_ulid" CHECK (length("site_members"."site_id") = 26),
	CONSTRAINT "ck_site_members_user_id_ulid" CHECK (length("site_members"."user_id") = 26),
	CONSTRAINT "ck_site_members_role_id_ulid" CHECK (length("site_members"."role_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "ck_sites_id_ulid" CHECK (length("sites"."id") = 26)
);
--> statement-breakpoint
CREATE TABLE "taxonomies" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"hierarchical" boolean DEFAULT false NOT NULL,
	"applies_to" jsonb NOT NULL,
	CONSTRAINT "uq_taxonomies_site_id_key" UNIQUE("site_id","key"),
	CONSTRAINT "ck_taxonomies_id_ulid" CHECK (length("taxonomies"."id") = 26),
	CONSTRAINT "ck_taxonomies_site_id_ulid" CHECK (length("taxonomies"."site_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "terms" (
	"id" text PRIMARY KEY NOT NULL,
	"taxonomy_id" text NOT NULL,
	"parent_id" text,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	CONSTRAINT "uq_terms_taxonomy_id_slug" UNIQUE("taxonomy_id","slug"),
	CONSTRAINT "ck_terms_id_ulid" CHECK (length("terms"."id") = 26),
	CONSTRAINT "ck_terms_taxonomy_id_ulid" CHECK (length("terms"."taxonomy_id") = 26),
	CONSTRAINT "ck_terms_parent_id_ulid" CHECK (length("terms"."parent_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "theme_overrides" (
	"theme_id" text NOT NULL,
	"template_key" text NOT NULL,
	"content" jsonb NOT NULL,
	"base_hash" text NOT NULL,
	"base_version" text NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "theme_overrides_theme_id_template_key_pk" PRIMARY KEY("theme_id","template_key"),
	CONSTRAINT "ck_theme_overrides_theme_id_ulid" CHECK (length("theme_overrides"."theme_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "themes" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"key" text NOT NULL,
	"version" text NOT NULL,
	"source" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"settings" jsonb NOT NULL,
	CONSTRAINT "uq_themes_site_id_key" UNIQUE("site_id","key"),
	CONSTRAINT "ck_themes_id_ulid" CHECK (length("themes"."id") = 26),
	CONSTRAINT "ck_themes_site_id_ulid" CHECK (length("themes"."site_id") = 26),
	CONSTRAINT "ck_themes_source" CHECK ("themes"."source" in ('build', 'runtime'))
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT false,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp (3) with time zone,
	CONSTRAINT "ck_two_factor_id_ulid" CHECK (length("two_factor"."id") = 26),
	CONSTRAINT "ck_two_factor_user_id_ulid" CHECK (length("two_factor"."user_id") = 26)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"two_factor_enabled" boolean DEFAULT false,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "uq_users_email" UNIQUE("email"),
	CONSTRAINT "ck_users_id_ulid" CHECK (length("users"."id") = 26)
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_types" ADD CONSTRAINT "content_types_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_parent_id_entries_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_locks" ADD CONSTRAINT "entry_locks_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_locks" ADD CONSTRAINT "entry_locks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_media" ADD CONSTRAINT "entry_media_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_media" ADD CONSTRAINT "entry_media_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_revisions" ADD CONSTRAINT "entry_revisions_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_revisions" ADD CONSTRAINT "entry_revisions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_terms" ADD CONSTRAINT "entry_terms_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_terms" ADD CONSTRAINT "entry_terms_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_permissions" ADD CONSTRAINT "extension_permissions_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_permissions" ADD CONSTRAINT "extension_permissions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_storage" ADD CONSTRAINT "extension_storage_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_definitions" ADD CONSTRAINT "field_definitions_content_type_id_content_types_id_fk" FOREIGN KEY ("content_type_id") REFERENCES "public"."content_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_folder_id_media_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."media_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_folders" ADD CONSTRAINT "media_folders_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_folders" ADD CONSTRAINT "media_folders_parent_id_media_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."media_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_variants" ADD CONSTRAINT "media_variants_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "not_found_log" ADD CONSTRAINT "not_found_log_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capabilities_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_members" ADD CONSTRAINT "site_members_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_members" ADD CONSTRAINT "site_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_members" ADD CONSTRAINT "site_members_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomies" ADD CONSTRAINT "taxonomies_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_taxonomy_id_taxonomies_id_fk" FOREIGN KEY ("taxonomy_id") REFERENCES "public"."taxonomies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_parent_id_terms_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theme_overrides" ADD CONSTRAINT "theme_overrides_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_audit_time" ON "audit_log" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_comments_entry" ON "comments" USING btree ("entry_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_entries_slug" ON "entries" USING btree ("site_id","type_key","locale","slug") WHERE "entries"."status" <> 'trash';--> statement-breakpoint
CREATE INDEX "ix_entries_list" ON "entries" USING btree ("site_id","type_key","status","updated_at");--> statement-breakpoint
CREATE INDEX "ix_entries_published" ON "entries" USING btree ("site_id","type_key","published_at");--> statement-breakpoint
CREATE INDEX "ix_entries_parent" ON "entries" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "ix_entries_scheduled" ON "entries" USING btree ("status","scheduled_at") WHERE "entries"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "ix_locks_expiry" ON "entry_locks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ix_entry_media_media" ON "entry_media" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "ix_revisions_entry" ON "entry_revisions" USING btree ("entry_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_entry_terms_term" ON "entry_terms" USING btree ("term_id");--> statement-breakpoint
CREATE INDEX "ix_jobs_due" ON "jobs" USING btree ("status","run_at") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "ix_media_folder" ON "media" USING btree ("site_id","folder_id");