// GENERATED once from docs/specs/01-data-model.md (CMS-Docs), then maintained by hand.
// Two property names follow Better Auth (credentialID, lastRequest); the column names are the spec's.
// The parity test (DM-16) keeps this file and the other dialect equal.

import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    twoFactorEnabled: boolean("two_factor_enabled").default(false),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_users_id_ulid", sql`length(${t.id}) = 26`),
    unique("uq_users_email").on(t.email),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_auth_sessions_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_auth_sessions_user_id_ulid", sql`length(${t.userId}) = 26`),
    unique("uq_auth_sessions_token").on(t.token),
  ],
);

export const authAccounts = pgTable(
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
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_auth_accounts_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_auth_accounts_user_id_ulid", sql`length(${t.userId}) = 26`),
  ],
);

export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: text("id").primaryKey().notNull(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [check("ck_auth_verifications_id_ulid", sql`length(${t.id}) = 26`)],
);

export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").default(false),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true, precision: 3, mode: "date" }),
  },
  (t) => [
    check("ck_two_factor_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_two_factor_user_id_ulid", sql`length(${t.userId}) = 26`),
  ],
);

export const passkeys = pgTable(
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
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    aaguid: text("aaguid"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3, mode: "date" }),
  },
  (t) => [
    check("ck_passkeys_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_passkeys_user_id_ulid", sql`length(${t.userId}) = 26`),
    unique("uq_passkeys_credential_id").on(t.credentialID),
  ],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    id: text("id").primaryKey().notNull(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    lastRequest: bigint("last_request_ms", { mode: "number" }).notNull(),
  },
  (t) => [
    check("ck_rate_limits_id_ulid", sql`length(${t.id}) = 26`),
    unique("uq_rate_limits_key").on(t.key),
  ],
);

export const sites = pgTable(
  "sites",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [check("ck_sites_id_ulid", sql`length(${t.id}) = 26`)],
);

export const siteMembers = pgTable(
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
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_site_members_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_site_members_user_id_ulid", sql`length(${t.userId}) = 26`),
    check("ck_site_members_role_id_ulid", sql`length(${t.roleId}) = 26`),
    primaryKey({ columns: [t.siteId, t.userId] }),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_roles_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_roles_site_id_ulid", sql`length(${t.siteId}) = 26`),
    unique("uq_roles_site_id_key").on(t.siteId, t.key),
  ],
);

export const roleCapabilities = pgTable(
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

export const contentTypes = pgTable(
  "content_types",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    urlRule: text("url_rule").notNull(),
    hasBody: boolean("has_body").notNull().default(true),
    hierarchical: boolean("hierarchical").notNull().default(false),
    icon: text("icon"),
    options: jsonb("options").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_content_types_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_content_types_site_id_ulid", sql`length(${t.siteId}) = 26`),
    unique("uq_content_types_site_id_key").on(t.siteId, t.key),
  ],
);

export const fieldDefinitions = pgTable(
  "field_definitions",
  {
    id: text("id").primaryKey().notNull(),
    contentTypeId: text("content_type_id")
      .notNull()
      .references(() => contentTypes.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    fieldType: text("field_type").notNull(),
    validation: jsonb("validation").notNull(),
    options: jsonb("options").notNull(),
    isSortable: boolean("is_sortable").notNull().default(false),
    isFilterable: boolean("is_filterable").notNull().default(false),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    check("ck_field_definitions_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_field_definitions_content_type_id_ulid", sql`length(${t.contentTypeId}) = 26`),
    unique("uq_field_definitions_content_type_id_key").on(t.contentTypeId, t.key),
  ],
);

export const entries = pgTable(
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
    parentId: text("parent_id").references((): AnyPgColumn => entries.id, { onDelete: "set null" }),
    locale: text("locale").notNull().default(""),
    fields: jsonb("fields").notNull(),
    body: jsonb("body").notNull(),
    plainText: text("plain_text").notNull().default(""),
    html: text("html").notNull().default(""),
    seo: jsonb("seo").notNull(),
    meta: jsonb("meta").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true, precision: 3, mode: "date" }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true, precision: 3, mode: "date" }),
    trashedAt: timestamp("trashed_at", { withTimezone: true, precision: 3, mode: "date" }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    revision: integer("revision").notNull().default(1),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
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
    uniqueIndex("uq_entries_slug")
      .on(t.siteId, t.typeKey, t.locale, t.slug)
      .where(sql`${t.status} <> 'trash'`),
    index("ix_entries_list").on(t.siteId, t.typeKey, t.status, t.updatedAt),
    index("ix_entries_published").on(t.siteId, t.typeKey, t.publishedAt),
    // What the site search reads to know whether its index is still fresh (spec 08, section 16).
    index("ix_entries_search").on(t.siteId, t.typeKey, t.status, t.locale, t.updatedAt),
    index("ix_entries_parent").on(t.parentId),
    index("ix_entries_scheduled")
      .on(t.status, t.scheduledAt)
      .where(sql`${t.status} = 'scheduled'`),
  ],
);

export const entryRevisions = pgTable(
  "entry_revisions",
  {
    id: text("id").primaryKey().notNull(),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    summary: text("summary").notNull().default(""),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_entry_revisions_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_entry_revisions_entry_id_ulid", sql`length(${t.entryId}) = 26`),
    check("ck_entry_revisions_kind", sql`${t.kind} in ('revision', 'autosave')`),
    check("ck_entry_revisions_author_id_ulid", sql`length(${t.authorId}) = 26`),
    index("ix_revisions_entry").on(t.entryId, t.createdAt),
  ],
);

export const entryLocks = pgTable(
  "entry_locks",
  {
    entryId: text("entry_id")
      .primaryKey()
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_entry_locks_entry_id_ulid", sql`length(${t.entryId}) = 26`),
    check("ck_entry_locks_user_id_ulid", sql`length(${t.userId}) = 26`),
    index("ix_locks_expiry").on(t.expiresAt),
  ],
);

export const taxonomies = pgTable(
  "taxonomies",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    hierarchical: boolean("hierarchical").notNull().default(false),
    appliesTo: jsonb("applies_to").notNull(),
  },
  (t) => [
    check("ck_taxonomies_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_taxonomies_site_id_ulid", sql`length(${t.siteId}) = 26`),
    unique("uq_taxonomies_site_id_key").on(t.siteId, t.key),
  ],
);

export const terms = pgTable(
  "terms",
  {
    id: text("id").primaryKey().notNull(),
    taxonomyId: text("taxonomy_id")
      .notNull()
      .references(() => taxonomies.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnyPgColumn => terms.id, { onDelete: "set null" }),
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

export const entryTerms = pgTable(
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

export const menus = pgTable(
  "menus",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    items: jsonb("items").notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_menus_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_menus_site_id_ulid", sql`length(${t.siteId}) = 26`),
    unique("uq_menus_site_id_key").on(t.siteId, t.key),
  ],
);

export const mediaFolders = pgTable(
  "media_folders",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnyPgColumn => mediaFolders.id, {
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

export const media = pgTable(
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
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    width: integer("width"),
    height: integer("height"),
    alt: text("alt").notNull().default(""),
    caption: text("caption").notNull().default(""),
    title: text("title").notNull().default(""),
    description: text("description").notNull().default(""),
    focalX: doublePrecision("focal_x"),
    focalY: doublePrecision("focal_y"),
    blurPlaceholder: text("blur_placeholder"),
    contentHash: text("content_hash").notNull(),
    status: text("status").notNull().default("ready"),
    uploadedBy: text("uploaded_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
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

export const mediaVariants = pgTable(
  "media_variants",
  {
    mediaId: text("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    width: integer("width").notNull(),
    format: text("format").notNull(),
    storageKey: text("storage_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  },
  (t) => [
    check("ck_media_variants_media_id_ulid", sql`length(${t.mediaId}) = 26`),
    primaryKey({ columns: [t.mediaId, t.width, t.format] }),
  ],
);

export const entryMedia = pgTable(
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

export const comments = pgTable(
  "comments",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnyPgColumn => comments.id, {
      onDelete: "set null",
    }),
    authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    authorEmailHash: text("author_email_hash"),
    content: text("content").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
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

export const settings = pgTable(
  "settings",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    revision: integer("revision").notNull().default(1),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_settings_site_id_ulid", sql`length(${t.siteId}) = 26`),
    primaryKey({ columns: [t.siteId, t.key] }),
  ],
);

export const themes = pgTable(
  "themes",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    version: text("version").notNull(),
    source: text("source").notNull(),
    isActive: boolean("is_active").notNull().default(false),
    settings: jsonb("settings").notNull(),
  },
  (t) => [
    check("ck_themes_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_themes_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_themes_source", sql`${t.source} in ('build', 'runtime')`),
    unique("uq_themes_site_id_key").on(t.siteId, t.key),
  ],
);

export const themeOverrides = pgTable(
  "theme_overrides",
  {
    themeId: text("theme_id")
      .notNull()
      .references(() => themes.id, { onDelete: "cascade" }),
    templateKey: text("template_key").notNull(),
    /** The published layout; null while the layout has only a draft (spec 05, section 17.5). */
    content: jsonb("content"),
    /** Changes not published yet; null when there are none. */
    draft: jsonb("draft"),
    kind: text("kind").notNull().default("theme"),
    name: text("name").notNull().default(""),
    baseHash: text("base_hash").notNull(),
    baseVersion: text("base_version").notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_theme_overrides_theme_id_ulid", sql`length(${t.themeId}) = 26`),
    check("ck_theme_overrides_kind", sql`${t.kind} in ('theme', 'owner-made')`),
    primaryKey({ columns: [t.themeId, t.templateKey] }),
  ],
);

export const themeOverrideVersions = pgTable(
  "theme_override_versions",
  {
    id: text("id").primaryKey().notNull(),
    themeId: text("theme_id")
      .notNull()
      .references(() => themes.id, { onDelete: "cascade" }),
    templateKey: text("template_key").notNull(),
    content: jsonb("content").notNull(),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    publishedBy: text("published_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    check("ck_theme_override_versions_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_theme_override_versions_theme_id_ulid", sql`length(${t.themeId}) = 26`),
    index("ix_theme_override_versions_layout").on(t.themeId, t.templateKey, t.publishedAt),
  ],
);

// Sections the owner saved by name (spec 05, sections 17.6 and 17.10). They belong to the site, not a theme, so they
// survive a theme switch. A layout places one as a copy, or as a `linked-section` block that stores only its id.
export const savedSections = pgTable(
  "saved_sections",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sectionGroup: text("section_group").notNull().default("other"),
    /** The published blocks. */
    content: jsonb("content").notNull(),
    /** Changes not published yet; null when there are none. */
    draft: jsonb("draft"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_saved_sections_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_saved_sections_site_id_ulid", sql`length(${t.siteId}) = 26`),
    unique("uq_saved_sections_site_id_name").on(t.siteId, t.name),
  ],
);

/** The last 20 published versions of each saved section. */
export const savedSectionVersions = pgTable(
  "saved_section_versions",
  {
    id: text("id").primaryKey().notNull(),
    sectionId: text("section_id")
      .notNull()
      .references(() => savedSections.id, { onDelete: "cascade" }),
    content: jsonb("content").notNull(),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    publishedBy: text("published_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    check("ck_saved_section_versions_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_saved_section_versions_section_id_ulid", sql`length(${t.sectionId}) = 26`),
    index("ix_saved_section_versions_section").on(t.sectionId, t.publishedAt),
  ],
);

export const extensions = pgTable(
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
    // What the plugin file says about the plugin, for the Plugins screen (see the SQLite schema).
    manifest: jsonb("manifest"),
    installedAt: timestamp("installed_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
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
export const extensionPendingUpdates = pgTable(
  "extension_pending_updates",
  {
    extensionId: text("extension_id")
      .primaryKey()
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    code: text("code").notNull(),
    integrity: text("integrity").notNull(),
    newPermissions: jsonb("new_permissions").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_extension_pending_updates_extension_id_ulid", sql`length(${t.extensionId}) = 26`),
  ],
);

// The bundle an update replaced, kept so rollback can start it again (spec 04, section 10,
// rule 6). At most one previous version per extension: a later update replaces this row too.
export const extensionPreviousVersions = pgTable(
  "extension_previous_versions",
  {
    extensionId: text("extension_id")
      .primaryKey()
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    code: text("code").notNull(),
    integrity: text("integrity").notNull(),
    replacedAt: timestamp("replaced_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_extension_previous_versions_extension_id_ulid", sql`length(${t.extensionId}) = 26`),
  ],
);

export const extensionPermissions = pgTable(
  "extension_permissions",
  {
    extensionId: text("extension_id")
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    grantedBy: text("granted_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    grantedAt: timestamp("granted_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_extension_permissions_extension_id_ulid", sql`length(${t.extensionId}) = 26`),
    check("ck_extension_permissions_granted_by_ulid", sql`length(${t.grantedBy}) = 26`),
    primaryKey({ columns: [t.extensionId, t.permission] }),
  ],
);

export const extensionStorage = pgTable(
  "extension_storage",
  {
    extensionId: text("extension_id")
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    collection: text("collection").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_extension_storage_extension_id_ulid", sql`length(${t.extensionId}) = 26`),
    primaryKey({ columns: [t.extensionId, t.collection, t.key] }),
  ],
);

/** Binary data (a file's bytes). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

// The files visitors send to a plugin (spec 16, section 6; permission `files:private`). They are kept here, in the
// database, never in the public media folder, and are opened only through an admin address for people who may manage
// plugins. A file starts as `pending` (it was received) and becomes `kept` when the plugin attaches it to one of its
// stored items; deleting the item deletes the file, and so does removing the plugin.
export const extensionFiles = pgTable(
  "extension_files",
  {
    id: text("id").primaryKey().notNull(),
    extensionId: text("extension_id")
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    status: text("status").notNull(),
    collection: text("collection"),
    key: text("key"),
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_extension_files_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_extension_files_extension_id_ulid", sql`length(${t.extensionId}) = 26`),
    check("ck_extension_files_status", sql`${t.status} in ('pending', 'kept')`),
    index("ix_extension_files_item").on(t.extensionId, t.collection, t.key),
    index("ix_extension_files_status").on(t.status, t.createdAt),
  ],
);

// A plugin's settings (spec 04, section 9). A secret setting holds only its sealed value, never the plain secret (PL-39).
export const extensionSettings = pgTable(
  "extension_settings",
  {
    extensionId: text("extension_id")
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    isSecret: boolean("is_secret").notNull().default(false),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_extension_settings_extension_id_ulid", sql`length(${t.extensionId}) = 26`),
    primaryKey({ columns: [t.extensionId, t.key] }),
  ],
);

export const redirects = pgTable(
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
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_redirects_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_redirects_site_id_ulid", sql`length(${t.siteId}) = 26`),
    unique("uq_redirects_site_id_from_path").on(t.siteId, t.fromPath),
  ],
);

export const notFoundLog = pgTable(
  "not_found_log",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    hits: integer("hits").notNull().default(1),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_not_found_log_site_id_ulid", sql`length(${t.siteId}) = 26`),
    primaryKey({ columns: [t.siteId, t.path] }),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    runAt: timestamp("run_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true, precision: 3, mode: "date" }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, precision: 3, mode: "date" }),
  },
  (t) => [
    check("ck_jobs_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_jobs_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_jobs_status", sql`${t.status} in ('queued', 'running', 'done', 'failed')`),
    index("ix_jobs_due")
      .on(t.status, t.runAt)
      .where(sql`${t.status} = 'queued'`),
  ],
);

export const auditLog = pgTable(
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
    detail: jsonb("detail").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_audit_log_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_audit_log_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check(
      "ck_audit_log_actor_type",
      sql`${t.actorType} in ('user', 'plugin', 'system', 'api_key')`,
    ),
    index("ix_audit_time").on(t.siteId, t.createdAt),
  ],
);

// The email record (spec 13, section 7): one row per email, kept 30 days. The message text is never stored, so reset
// links and private words stay out of it.
export const emailLog = pgTable(
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
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true, precision: 3, mode: "date" }),
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
export const emailTexts = pgTable(
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
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_email_texts_site_id_ulid", sql`length(${t.siteId}) = 26`),
    primaryKey({ columns: [t.siteId, t.emailKey, t.locale] }),
  ],
);

// The browsers a person signed in from (spec 13, section 5: the alert for a sign-in from a new device). Only a hash of
// the random value in the device cookie is kept, with a short description of the browser.
export const knownDevices = pgTable(
  "known_devices",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceHash: text("device_hash").notNull(),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_known_devices_user_id_ulid", sql`length(${t.userId}) = 26`),
    primaryKey({ columns: [t.userId, t.deviceHash] }),
  ],
);

// Site search statistics (spec 08, section 16.3): only the word, the day and the counts; nothing that points to a person.
export const searchTerms = pgTable(
  "search_terms",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    term: text("term").notNull(),
    day: text("day").notNull(),
    searches: integer("searches").notNull().default(0),
    noResults: integer("no_results").notNull().default(0),
  },
  (t) => [
    check("ck_search_terms_site_id_ulid", sql`length(${t.siteId}) = 26`),
    primaryKey({ columns: [t.siteId, t.term, t.day] }),
    index("ix_search_terms_day").on(t.siteId, t.day),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: jsonb("scopes").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, precision: 3, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, precision: 3, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, precision: 3, mode: "date" }),
  },
  (t) => [
    check("ck_api_keys_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_api_keys_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_api_keys_created_by_ulid", sql`length(${t.createdBy}) = 26`),
    unique("uq_api_keys_key_hash").on(t.keyHash),
  ],
);

/** Which cache tags changed and when (spec 01, decision D82). Every server process reads it before a request. */
export const cacheTags = pgTable(
  "cache_tags",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    staleAt: timestamp("stale_at", { withTimezone: true, precision: 3, mode: "date" }),
    expiredAt: timestamp("expired_at", { withTimezone: true, precision: 3, mode: "date" }),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_cache_tags_site_id_ulid", sql`length(${t.siteId}) = 26`),
    primaryKey({ columns: [t.siteId, t.tag] }),
    index("ix_cache_tags_updated").on(t.siteId, t.updatedAt),
  ],
);

// A request from a visitor to see or delete the personal data the site keeps about them (spec 18, section 5). The address
// is kept as a hash for matching, and sealed (with the site's secret) only until the request is answered so the owner can
// reach the person; the link in the confirmation email is kept as a hash. A request is `pending` until the person opens the
// link, `confirmed` until the owner answers it, then `answered`.
export const privacyRequests = pgTable(
  "privacy_requests",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    emailHash: text("email_hash").notNull(),
    emailSealed: text("email_sealed"),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, precision: 3, mode: "date" }),
    doneAt: timestamp("done_at", { withTimezone: true, precision: 3, mode: "date" }),
    // Which reminder the administrators got: 0 none, 1 "due within 7 days", 2 "overdue".
    reminderStage: integer("reminder_stage").notNull().default(0),
  },
  (t) => [
    check("ck_privacy_requests_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_privacy_requests_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_privacy_requests_kind", sql`${t.kind} in ('export', 'delete')`),
    check("ck_privacy_requests_status", sql`${t.status} in ('pending', 'confirmed', 'answered')`),
    uniqueIndex("uq_privacy_requests_token").on(t.tokenHash),
    index("ix_privacy_requests_site").on(t.siteId, t.status, t.createdAt),
    index("ix_privacy_requests_address").on(t.siteId, t.emailHash, t.createdAt),
  ],
);

// What a visitor chose in the consent notice (spec 18, section 2): when, which purposes, and the notice version, as proof
// that consent was asked for. Nothing in a line points to a person: no address, no cookie, no visitor number.
export const consentRecords = pgTable(
  "consent_records",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    // The purposes that were accepted, for example "media,statistics"; empty when the visitor refused all.
    choice: text("choice").notNull(),
    // Which purposes the notice asked about at that time, so a record can be read later.
    version: text("version").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_consent_records_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_consent_records_site_id_ulid", sql`length(${t.siteId}) = 26`),
    index("ix_consent_records_site").on(t.siteId, t.createdAt),
  ],
);

// Visitor statistics (spec 18, section 3): daily totals only. A row counts one thing for one day: `kind` is "views",
// "visitors", "page", "referrer", "search", "country" or "device", `key` says which one (a page address, a host, a country
// code...). Nothing in it points to a person.
export const statsDaily = pgTable(
  "stats_daily",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    // The day, as YYYY-MM-DD in UTC.
    day: text("day").notNull(),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.day, t.kind, t.key] })],
);

// Which visitors were counted today, so that one visitor is counted once a day. A line is a hash made with a secret that
// changes every day; it cannot be turned back into an address, and lines of earlier days are deleted.
export const statsSeen = pgTable(
  "stats_seen",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.day, t.hash] })],
);

// Client content collection (spec 11, section 8): a guided link an agency gives a client, and what the client sends through it.
// Only a hash of the link's token is kept. What is sent waits in `collect_items`, out of the public library, until a person of
// the site accepts it; a file's bytes are kept here (not in the library's storage, which is public) and are emptied on accept.
export const collectLinks = pgTable(
  "collect_links",
  {
    id: text("id").primaryKey().notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    label: text("label").notNull(),
    note: text("note").notNull().default(""),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    maxFiles: integer("max_files").notNull(),
    maxBytes: bigint("max_bytes", { mode: "number" }).notNull(),
    maxText: integer("max_text").notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true, precision: 3, mode: "date" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_collect_links_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_collect_links_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_collect_links_created_by_ulid", sql`length(${t.createdBy}) = 26`),
    uniqueIndex("uq_collect_links_token").on(t.tokenHash),
    index("ix_collect_links_site").on(t.siteId, t.createdAt),
  ],
);

export const collectItems = pgTable(
  "collect_items",
  {
    id: text("id").primaryKey().notNull(),
    linkId: text("link_id")
      .notNull()
      .references(() => collectLinks.id, { onDelete: "cascade" }),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    sender: text("sender").notNull().default(""),
    body: text("body").notNull().default(""),
    fileName: text("file_name"),
    mime: text("mime"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    data: bytea("data"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("ck_collect_items_id_ulid", sql`length(${t.id}) = 26`),
    check("ck_collect_items_link_id_ulid", sql`length(${t.linkId}) = 26`),
    check("ck_collect_items_site_id_ulid", sql`length(${t.siteId}) = 26`),
    check("ck_collect_items_kind", sql`${t.kind} in ('text', 'file')`),
    check("ck_collect_items_status", sql`${t.status} in ('pending', 'accepted')`),
    index("ix_collect_items_link").on(t.linkId, t.createdAt),
    index("ix_collect_items_site").on(t.siteId, t.status, t.createdAt),
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
  "extension_files",
  "extension_settings",
  "redirects",
  "not_found_log",
  "jobs",
  "audit_log",
  "email_log",
  "email_texts",
  "known_devices",
  "search_terms",
  "api_keys",
  "cache_tags",
  "privacy_requests",
  "consent_records",
  "stats_daily",
  "stats_seen",
  "collect_links",
  "collect_items",
] as const;
