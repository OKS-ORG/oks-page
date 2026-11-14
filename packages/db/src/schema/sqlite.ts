// GENERATED once from docs/specs/01-data-model.md (CMS-Docs), then maintained by hand.
// Two property names follow Better Auth (credentialID, lastRequest); the column names are the spec's.
// The parity test (DM-16) keeps this file and the other dialect equal.

import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    image: text("image"),
    twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_users_id_ulid", sql`length(${t.id}) = 26`),
    unique("uq_users_email").on(t.email),
  ],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_auth_sessions_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_auth_sessions_user_id_ulid", sql`length(${t.userId}) = 26`),
    unique("uq_auth_sessions_token").on(t.token),
  ],
);

export const authAccounts = sqliteTable(
  "auth_accounts",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_auth_accounts_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_auth_accounts_user_id_ulid", sql`length(${t.userId}) = 26`),
  ],
);

export const authVerifications = sqliteTable(
  "auth_verifications",
  {
    id: text("id").primaryKey().notNull(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [check("ck_auth_verifications_id_ulid", sql`length(${t.id}) = 26`)],
);

export const twoFactor = sqliteTable(
  "two_factor",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: integer("verified", { mode: "boolean" }).default(false),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: integer("locked_until", { mode: "timestamp_ms" }),
  },
  (t) => [
    check("ck_two_factor_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_two_factor_user_id_ulid", sql`length(${t.userId}) = 26`),
  ],
);

export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
    transports: text("transports"),
    aaguid: text("aaguid"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    check("ck_passkeys_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_passkeys_user_id_ulid", sql`length(${t.userId}) = 26`),
    unique("uq_passkeys_credential_id").on(t.credentialID),
  ],
);

export const rateLimits = sqliteTable(
  "rate_limits",
  {
    id: text("id").primaryKey().notNull(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    lastRequest: integer("last_request_ms").notNull(),
  },
  (t) => [
    check("ck_rate_limits_id_ulid", sql`length(${t.id}) = 26`),
    unique("uq_rate_limits_key").on(t.key),
  ],
);

export const sites = sqliteTable(
  "sites",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [check("ck_sites_id_ulid", sql`length(${t.id}) = 26`)],
);

export const siteMembers = sqliteTable(
  "site_members",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_site_members_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_site_members_user_id_ulid", sql`length(${t.userId}) = 26`),
    check("ck_site_members_role_id_ulid", sql`length(${t.roleId}) = 26`),
    primaryKey({ columns: [t.siteId, t.userId] }),
  ],
);

export const roles = sqliteTable(
  "roles",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_roles_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_roles_site_id_ulid", sql`length(${t.siteId}) = 26`),
    unique("uq_roles_site_id_key").on(t.siteId, t.key),
  ],
);

export const roleCapabilities = sqliteTable(
  "role_capabilities",
  {
    id: text("id").primaryKey().notNull(),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    scopeTypeKey: text("scope_type_key").notNull().default(""),
  },
  (t) => [
    check("ck_role_capabilities_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_role_capabilities_role_id_ulid", sql`length(${t.roleId}) = 26`),
    unique("uq_role_capabilities_role_id_capability_scope_type_key").on(
      t.roleId,
      t.capability,
      t.scopeTypeKey,
    ),
  ],
);

export const contentTypes = sqliteTable(
  "content_types",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    urlRule: text("url_rule").notNull(),
    hasBody: integer("has_body", { mode: "boolean" }).notNull().default(true),
    hierarchical: integer("hierarchical", { mode: "boolean" }).notNull().default(false),
    icon: text("icon"),
    options: text("options", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_content_types_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_content_types_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_content_types_options_json", sql`json_valid(${t.options})`),
    unique("uq_content_types_site_id_key").on(t.siteId, t.key),
  ],
);

export const fieldDefinitions = sqliteTable(
  "field_definitions",
  {
    id: text("id").primaryKey().notNull(),
    contentTypeId: text("content_type_id")
      .notNull()
      .references(() => contentTypes.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    fieldType: text("field_type").notNull(),
    validation: text("validation", { mode: "json" }).notNull(),
    options: text("options", { mode: "json" }).notNull(),
    isSortable: integer("is_sortable", { mode: "boolean" }).notNull().default(false),
    isFilterable: integer("is_filterable", { mode: "boolean" }).notNull().default(false),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    check("ck_field_definitions_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_field_definitions_content_type_id_ulid", sql`length(${t.contentTypeId}) = 26`),
    check("ck_field_definitions_validation_json", sql`json_valid(${t.validation})`),
    check("ck_field_definitions_options_json", sql`json_valid(${t.options})`),
    unique("uq_field_definitions_content_type_id_key").on(t.contentTypeId, t.key),
  ],
);

export const entries = sqliteTable(
  "entries",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    typeKey: text("type_key").notNull(),
    status: text("status").notNull().default("draft"),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    parentId: text("parent_id").references((): AnySQLiteColumn => entries.id, {
      onDelete: "set null",
    }),
    locale: text("locale").notNull().default(""),
    fields: text("fields", { mode: "json" }).notNull(),
    body: text("body", { mode: "json" }).notNull(),
    plainText: text("plain_text").notNull().default(""),
    html: text("html").notNull().default(""),
    seo: text("seo", { mode: "json" }).notNull(),
    meta: text("meta", { mode: "json" }).notNull(),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    scheduledAt: integer("scheduled_at", { mode: "timestamp_ms" }),
    trashedAt: integer("trashed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    revision: integer("revision").notNull().default(1),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_entries_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_entries_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check(
      "ck_entries_status",
      sql`${t.status} in ('draft', 'pending', 'scheduled', 'published', 'private', 'trash')`,
    ),
    check("ck_entries_author_id_ulid", sql`length(${t.authorId}) = 26`),
    check("ck_entries_parent_id_ulid", sql`length(${t.parentId}) = 26`),
    check("ck_entries_fields_json", sql`json_valid(${t.fields})`),
    check("ck_entries_body_json", sql`json_valid(${t.body})`),
    check("ck_entries_seo_json", sql`json_valid(${t.seo})`),
    check("ck_entries_meta_json", sql`json_valid(${t.meta})`),
    uniqueIndex("uq_entries_slug")
      .on(t.siteId, t.typeKey, t.locale, t.slug)
      .where(sql`${t.status} <> 'trash'`),
    index("ix_entries_list").on(t.siteId, t.typeKey, t.status, t.updatedAt),
    index("ix_entries_published").on(t.siteId, t.typeKey, t.publishedAt),
    index("ix_entries_parent").on(t.parentId),
    index("ix_entries_scheduled")
      .on(t.status, t.scheduledAt)
      .where(sql`${t.status} = 'scheduled'`),
  ],
);

export const entryRevisions = sqliteTable(
  "entry_revisions",
  {
    id: text("id").primaryKey().notNull(),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    snapshot: text("snapshot", { mode: "json" }).notNull(),
    summary: text("summary").notNull().default(""),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_entry_revisions_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_entry_revisions_entry_id_ulid", sql`length(${t.entryId}) = 26`),
    check("ck_entry_revisions_kind", sql`${t.kind} in ('revision', 'autosave')`),
    check("ck_entry_revisions_snapshot_json", sql`json_valid(${t.snapshot})`),
    check("ck_entry_revisions_author_id_ulid", sql`length(${t.authorId}) = 26`),
    index("ix_revisions_entry").on(t.entryId, t.createdAt),
  ],
);

export const entryLocks = sqliteTable(
  "entry_locks",
  {
    entryId: text("entry_id")
      .primaryKey()
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_entry_locks_entry_id_ulid", sql`length(${t.entryId}) = 26`),
    check("ck_entry_locks_user_id_ulid", sql`length(${t.userId}) = 26`),
    index("ix_locks_expiry").on(t.expiresAt),
  ],
);

export const taxonomies = sqliteTable(
  "taxonomies",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    hierarchical: integer("hierarchical", { mode: "boolean" }).notNull().default(false),
    appliesTo: text("applies_to", { mode: "json" }).notNull(),
  },
  (t) => [
    check("ck_taxonomies_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_taxonomies_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_taxonomies_applies_to_json", sql`json_valid(${t.appliesTo})`),
    unique("uq_taxonomies_site_id_key").on(t.siteId, t.key),
  ],
);

export const terms = sqliteTable(
  "terms",
  {
    id: text("id").primaryKey().notNull(),
    taxonomyId: text("taxonomy_id")
      .notNull()
      .references(() => taxonomies.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnySQLiteColumn => terms.id, {
      onDelete: "set null",
    }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
  },
  (t) => [
    check("ck_terms_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_terms_taxonomy_id_ulid", sql`length(${t.taxonomyId}) = 26`),
    check("ck_terms_parent_id_ulid", sql`length(${t.parentId}) = 26`),
    unique("uq_terms_taxonomy_id_slug").on(t.taxonomyId, t.slug),
  ],
);

export const entryTerms = sqliteTable(
  "entry_terms",
  {
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    termId: text("term_id")
      .notNull()
      .references(() => terms.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    check("ck_entry_terms_entry_id_ulid", sql`length(${t.entryId}) = 26`),
    check("ck_entry_terms_term_id_ulid", sql`length(${t.termId}) = 26`),
    primaryKey({ columns: [t.entryId, t.termId] }),
    index("ix_entry_terms_term").on(t.termId),
  ],
);

export const menus = sqliteTable(
  "menus",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    items: text("items", { mode: "json" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_menus_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_menus_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_menus_items_json", sql`json_valid(${t.items})`),
    unique("uq_menus_site_id_key").on(t.siteId, t.key),
  ],
);

export const mediaFolders = sqliteTable(
  "media_folders",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnySQLiteColumn => mediaFolders.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
  },
  (t) => [
    check("ck_media_folders_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_media_folders_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_media_folders_parent_id_ulid", sql`length(${t.parentId}) = 26`),
  ],
);

export const media = sqliteTable(
  "media",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    folderId: text("folder_id").references(() => mediaFolders.id, { onDelete: "set null" }),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    alt: text("alt").notNull().default(""),
    caption: text("caption").notNull().default(""),
    title: text("title").notNull().default(""),
    description: text("description").notNull().default(""),
    focalX: real("focal_x"),
    focalY: real("focal_y"),
    blurPlaceholder: text("blur_placeholder"),
    contentHash: text("content_hash").notNull(),
    status: text("status").notNull().default("ready"),
    uploadedBy: text("uploaded_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_media_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_media_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_media_folder_id_ulid", sql`length(${t.folderId}) = 26`),
    check("ck_media_status", sql`${t.status} in ('processing', 'ready', 'failed')`),
    check("ck_media_uploaded_by_ulid", sql`length(${t.uploadedBy}) = 26`),
    unique("uq_media_site_id_storage_key").on(t.siteId, t.storageKey),
    index("ix_media_folder").on(t.siteId, t.folderId),
  ],
);

export const mediaVariants = sqliteTable(
  "media_variants",
  {
    mediaId: text("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    width: integer("width").notNull(),
    format: text("format").notNull(),
    storageKey: text("storage_key").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
  },
  (t) => [
    check("ck_media_variants_media_id_ulid", sql`length(${t.mediaId}) = 26`),
    primaryKey({ columns: [t.mediaId, t.width, t.format] }),
  ],
);

export const entryMedia = sqliteTable(
  "entry_media",
  {
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    mediaId: text("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
  },
  (t) => [
    check("ck_entry_media_entry_id_ulid", sql`length(${t.entryId}) = 26`),
    check("ck_entry_media_media_id_ulid", sql`length(${t.mediaId}) = 26`),
    primaryKey({ columns: [t.entryId, t.mediaId, t.field] }),
    index("ix_entry_media_media").on(t.mediaId),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnySQLiteColumn => comments.id, {
      onDelete: "set null",
    }),
    authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    authorEmailHash: text("author_email_hash"),
    content: text("content").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_comments_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_comments_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_comments_entry_id_ulid", sql`length(${t.entryId}) = 26`),
    check("ck_comments_parent_id_ulid", sql`length(${t.parentId}) = 26`),
    check("ck_comments_author_user_id_ulid", sql`length(${t.authorUserId}) = 26`),
    check("ck_comments_status", sql`${t.status} in ('pending', 'approved', 'spam', 'trash')`),
    index("ix_comments_entry").on(t.entryId, t.status, t.createdAt),
  ],
);

export const settings = sqliteTable(
  "settings",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value", { mode: "json" }).notNull(),
    revision: integer("revision").notNull().default(1),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_settings_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_settings_value_json", sql`json_valid(${t.value})`),
    primaryKey({ columns: [t.siteId, t.key] }),
  ],
);

export const themes = sqliteTable(
  "themes",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    version: text("version").notNull(),
    source: text("source").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
    settings: text("settings", { mode: "json" }).notNull(),
  },
  (t) => [
    check("ck_themes_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_themes_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_themes_source", sql`${t.source} in ('build', 'runtime')`),
    check("ck_themes_settings_json", sql`json_valid(${t.settings})`),
    unique("uq_themes_site_id_key").on(t.siteId, t.key),
  ],
);

export const themeOverrides = sqliteTable(
  "theme_overrides",
  {
    themeId: text("theme_id")
      .notNull()
      .references(() => themes.id, { onDelete: "cascade" }),
    templateKey: text("template_key").notNull(),
    /** The published layout; null while the layout has only a draft (spec 05, section 17.5). */
    content: text("content", { mode: "json" }),
    /** Changes not published yet; null when there are none. */
    draft: text("draft", { mode: "json" }),
    kind: text("kind").notNull().default("theme"),
    name: text("name").notNull().default(""),
    baseHash: text("base_hash").notNull(),
    baseVersion: text("base_version").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_theme_overrides_theme_id_ulid", sql`length(${t.themeId}) = 26`),
    check("ck_theme_overrides_content_json", sql`${t.content} is null or json_valid(${t.content})`),
    check("ck_theme_overrides_draft_json", sql`${t.draft} is null or json_valid(${t.draft})`),
    check("ck_theme_overrides_kind", sql`${t.kind} in ('theme', 'owner-made')`),
    primaryKey({ columns: [t.themeId, t.templateKey] }),
  ],
);

export const themeOverrideVersions = sqliteTable(
  "theme_override_versions",
  {
    id: text("id").primaryKey().notNull(),
    themeId: text("theme_id")
      .notNull()
      .references(() => themes.id, { onDelete: "cascade" }),
    templateKey: text("template_key").notNull(),
    content: text("content", { mode: "json" }).notNull(),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }).notNull(),
    publishedBy: text("published_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    check("ck_theme_override_versions_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_theme_override_versions_theme_id_ulid", sql`length(${t.themeId}) = 26`),
    check("ck_theme_override_versions_content_json", sql`json_valid(${t.content})`),
    index("ix_theme_override_versions_layout").on(t.themeId, t.templateKey, t.publishedAt),
  ],
);

// Sections the owner saved by name (spec 05, sections 17.6 and 17.10). They belong to the site, not a theme, so they
// survive a theme switch. A layout places one as a copy, or as a `linked-section` block that stores only its id.
export const savedSections = sqliteTable(
  "saved_sections",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sectionGroup: text("section_group").notNull().default("other"),
    /** The published blocks. */
    content: text("content", { mode: "json" }).notNull(),
    /** Changes not published yet; null when there are none. */
    draft: text("draft", { mode: "json" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_saved_sections_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_saved_sections_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_saved_sections_content_json", sql`json_valid(${t.content})`),
    check("ck_saved_sections_draft_json", sql`${t.draft} is null or json_valid(${t.draft})`),
    unique("uq_saved_sections_site_id_name").on(t.siteId, t.name),
  ],
);

/** The last 20 published versions of each saved section. */
export const savedSectionVersions = sqliteTable(
  "saved_section_versions",
  {
    id: text("id").primaryKey().notNull(),
    sectionId: text("section_id")
      .notNull()
      .references(() => savedSections.id, { onDelete: "cascade" }),
    content: text("content", { mode: "json" }).notNull(),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }).notNull(),
    publishedBy: text("published_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    check("ck_saved_section_versions_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_saved_section_versions_section_id_ulid", sql`length(${t.sectionId}) = 26`),
    check("ck_saved_section_versions_content_json", sql`json_valid(${t.content})`),
    index("ix_saved_section_versions_section").on(t.sectionId, t.publishedAt),
  ],
);

export const extensions = sqliteTable(
  "extensions",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    version: text("version").notNull(),
    tier: text("tier").notNull(),
    status: text("status").notNull().default("enabled"),
    licenseKeyHash: text("license_key_hash"),
    // The running bundle (spec 04, section 10). Null for rows older than this column, and for
    // tests that only need the row to exist, not a real plugin to start.
    code: text("code"),
    integrity: text("integrity"),
    installedAt: integer("installed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_extensions_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_extensions_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_extensions_kind", sql`${t.kind} in ('plugin', 'theme')`),
    check("ck_extensions_tier", sql`${t.tier} in ('runtime', 'build')`),
    check("ck_extensions_status", sql`${t.status} in ('enabled', 'disabled', 'switched_off')`),
    unique("uq_extensions_site_id_key").on(t.siteId, t.key),
  ],
);

// An update is stored here instead of applied when it asks for a permission the owner has not
// already granted (spec 04, section 10, rule 5). At most one pending update per extension: a
// second update before the first is approved replaces it.
export const extensionPendingUpdates = sqliteTable(
  "extension_pending_updates",
  {
    extensionId: text("extension_id")
      .primaryKey()
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    code: text("code").notNull(),
    integrity: text("integrity").notNull(),
    newPermissions: text("new_permissions", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_extension_pending_updates_extension_id_ulid", sql`length(${t.extensionId}) = 26`),
    check(
      "ck_extension_pending_updates_new_permissions_json",
      sql`json_valid(${t.newPermissions})`,
    ),
  ],
);

// The bundle an update replaced, kept so rollback can start it again (spec 04, section 10,
// rule 6). At most one previous version per extension: a later update replaces this row too.
export const extensionPreviousVersions = sqliteTable(
  "extension_previous_versions",
  {
    extensionId: text("extension_id")
      .primaryKey()
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    code: text("code").notNull(),
    integrity: text("integrity").notNull(),
    replacedAt: integer("replaced_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_extension_previous_versions_extension_id_ulid", sql`length(${t.extensionId}) = 26`),
  ],
);

export const extensionPermissions = sqliteTable(
  "extension_permissions",
  {
    extensionId: text("extension_id")
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    grantedBy: text("granted_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    grantedAt: integer("granted_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_extension_permissions_extension_id_ulid", sql`length(${t.extensionId}) = 26`),
    check("ck_extension_permissions_granted_by_ulid", sql`length(${t.grantedBy}) = 26`),
    primaryKey({ columns: [t.extensionId, t.permission] }),
  ],
);

export const extensionStorage = sqliteTable(
  "extension_storage",
  {
    extensionId: text("extension_id")
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    collection: text("collection").notNull(),
    key: text("key").notNull(),
    value: text("value", { mode: "json" }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_extension_storage_extension_id_ulid", sql`length(${t.extensionId}) = 26`),
    check("ck_extension_storage_value_json", sql`json_valid(${t.value})`),
    primaryKey({ columns: [t.extensionId, t.collection, t.key] }),
  ],
);

// A plugin's settings (spec 04, section 9). A secret setting holds only its sealed value, never the plain secret (PL-39).
export const extensionSettings = sqliteTable(
  "extension_settings",
  {
    extensionId: text("extension_id")
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value", { mode: "json" }).notNull(),
    isSecret: integer("is_secret", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_extension_settings_extension_id_ulid", sql`length(${t.extensionId}) = 26`),
    check("ck_extension_settings_value_json", sql`json_valid(${t.value})`),
    primaryKey({ columns: [t.extensionId, t.key] }),
  ],
);

export const redirects = sqliteTable(
  "redirects",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    fromPath: text("from_path").notNull(),
    toPath: text("to_path").notNull(),
    statusCode: integer("status_code").notNull().default(301),
    hitCount: integer("hit_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_redirects_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_redirects_site_id_ulid", sql`length(${t.siteId}) = 26`),
    unique("uq_redirects_site_id_from_path").on(t.siteId, t.fromPath),
  ],
);

export const notFoundLog = sqliteTable(
  "not_found_log",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    hits: integer("hits").notNull().default(1),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_not_found_log_site_id_ulid", sql`length(${t.siteId}) = 26`),
    primaryKey({ columns: [t.siteId, t.path] }),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    runAt: integer("run_at", { mode: "timestamp_ms" }).notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedBy: text("locked_by"),
    lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    check("ck_jobs_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_jobs_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_jobs_payload_json", sql`json_valid(${t.payload})`),
    check("ck_jobs_status", sql`${t.status} in ('queued', 'running', 'done', 'failed')`),
    index("ix_jobs_due")
      .on(t.status, t.runAt)
      .where(sql`${t.status} = 'queued'`),
  ],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    detail: text("detail", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_audit_log_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_audit_log_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check(
      "ck_audit_log_actor_type",
      sql`${t.actorType} in ('user', 'plugin', 'system', 'api_key')`,
    ),
    check("ck_audit_log_detail_json", sql`json_valid(${t.detail})`),
    index("ix_audit_time").on(t.siteId, t.createdAt),
  ],
);

// The email record (spec 13, section 7): one row per email, kept 30 days. The message text is never stored, so reset
// links and private words stay out of it.
export const emailLog = sqliteTable(
  "email_log",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    emailKey: text("email_key").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("queued"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastAttemptAt: integer("last_attempt_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    check("ck_email_log_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_email_log_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check(
      "ck_email_log_status",
      sql`${t.status} in ('queued', 'sent', 'retrying', 'failed', 'dropped')`,
    ),
    index("ix_email_log_time").on(t.siteId, t.createdAt),
  ],
);

// The owner's own words for an email (spec 13, section 6): one row per email and language; without a row the original
// text is used. `locale` is "" for the site's language.
export const emailTexts = sqliteTable(
  "email_texts",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    emailKey: text("email_key").notNull(),
    locale: text("locale").notNull().default(""),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_email_texts_site_id_ulid", sql`length(${t.siteId}) = 26`),
    primaryKey({ columns: [t.siteId, t.emailKey, t.locale] }),
  ],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: text("scopes", { mode: "json" }).notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    check("ck_api_keys_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_api_keys_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_api_keys_scopes_json", sql`json_valid(${t.scopes})`),
    check("ck_api_keys_created_by_ulid", sql`length(${t.createdBy}) = 26`),
    unique("uq_api_keys_key_hash").on(t.keyHash),
  ],
);

/** Which cache tags changed and when (spec 01, decision D82). Every server process reads it before a request. */
export const cacheTags = sqliteTable(
  "cache_tags",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    staleAt: integer("stale_at", { mode: "timestamp_ms" }),
    expiredAt: integer("expired_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("ck_cache_tags_site_id_ulid", sql`length(${t.siteId}) = 26`),
    primaryKey({ columns: [t.siteId, t.tag] }),
    index("ix_cache_tags_updated").on(t.siteId, t.updatedAt),
  ],
);

export const tableNames = [
  "users",
  "auth_sessions",
  "auth_accounts",
  "auth_verifications",
  "two_factor",
  "passkeys",
  "rate_limits",
  "sites",
  "site_members",
  "roles",
  "role_capabilities",
  "content_types",
  "field_definitions",
  "entries",
  "entry_revisions",
  "entry_locks",
  "taxonomies",
  "terms",
  "entry_terms",
  "menus",
  "media_folders",
  "media",
  "media_variants",
  "entry_media",
  "comments",
  "settings",
  "themes",
  "theme_overrides",
  "theme_override_versions",
  "saved_sections",
  "saved_section_versions",
  "extensions",
  "extension_pending_updates",
  "extension_previous_versions",
  "extension_permissions",
  "extension_storage",
  "extension_settings",
  "redirects",
  "not_found_log",
  "jobs",
  "audit_log",
  "email_log",
  "email_texts",
  "api_keys",
  "cache_tags",
] as const;
