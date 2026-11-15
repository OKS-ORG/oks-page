// A small data set that puts at least one row in every table, with the awkward values that a move between
// databases can damage: emoji and non-Latin text, nested JSON, null JSON members, a decimal, and a whole number
// above 2^31.
import { ms, type TestDb } from "./harness.js";

const id = (n: number) => `SEED${String(n).padStart(22, "0")}`;
const T = ms(1_700_000_000_123);
const T2 = ms(1_700_000_456_789);

async function ins(db: TestDb, table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  await db.run(
    `insert into ${table} (${cols.join(", ")}) values (${cols.map(() => "?").join(", ")})`,
    Object.values(row),
  );
}

export async function seedEverything(db: TestDb): Promise<void> {
  const site = id(1);
  const user = id(2);
  const user2 = id(3);
  const role = id(4);
  await ins(db, "users", {
    id: user,
    name: "Asha Rao 🌸",
    email: "asha@example.com",
    email_verified: true,
    created_at: T,
    updated_at: T,
  });
  await ins(db, "users", {
    id: user2,
    name: "Zoë",
    email: "zoe@example.com",
    created_at: T,
    updated_at: T2,
  });
  await ins(db, "auth_sessions", {
    id: id(5),
    user_id: user,
    token: "tok-1",
    expires_at: T2,
    ip_address: "203.0.113.5",
    created_at: T,
    updated_at: T,
  });
  await ins(db, "auth_accounts", {
    id: id(6),
    user_id: user,
    account_id: "a1",
    provider_id: "credential",
    password: "hash",
    created_at: T,
    updated_at: T,
  });
  await ins(db, "auth_verifications", {
    id: id(7),
    identifier: "asha@example.com",
    value: "123456",
    expires_at: T2,
    created_at: T,
    updated_at: T,
  });
  await ins(db, "two_factor", {
    id: id(8),
    user_id: user,
    secret: "s",
    backup_codes: "b",
    verified: true,
    failed_verification_count: 2,
    locked_until: T2,
  });
  await ins(db, "passkeys", {
    id: id(9),
    user_id: user,
    name: "Laptop",
    public_key: "pk",
    credential_id: "cred-1",
    counter: 7,
    device_type: "multiDevice",
    backed_up: true,
    created_at: T,
  });
  await ins(db, "rate_limits", {
    id: id(10),
    key: "signin:asha@example.com",
    count: 3,
    last_request_ms: 1_700_000_000_123,
  });
  await ins(db, "sites", { id: site, name: "मेरी साइट", created_at: T, updated_at: T });
  await ins(db, "roles", {
    id: role,
    site_id: site,
    key: "editor",
    label: "Editor",
    is_system: true,
    created_at: T,
  });
  await ins(db, "role_capabilities", {
    id: id(11),
    role_id: role,
    capability: "entries.edit",
    scope_type_key: "post",
  });
  await ins(db, "site_members", { site_id: site, user_id: user, role_id: role, created_at: T });
  const ct = id(12);
  await ins(db, "content_types", {
    id: ct,
    site_id: site,
    key: "post",
    label: "Post",
    url_rule: "/{slug}",
    options: JSON.stringify({ supports: ["title", "body"], nested: { a: [1, 2, { b: null }] } }),
    created_at: T,
    updated_at: T,
  });
  await ins(db, "field_definitions", {
    id: id(13),
    content_type_id: ct,
    key: "price",
    label: "Price",
    field_type: "number",
    validation: JSON.stringify({ min: 0 }),
    options: "{}",
    is_sortable: true,
    position: 1,
  });
  const parent = id(14);
  const child = id(15);
  const entryRow = (eid: string, slug: string, parentId: string | null) => ({
    id: eid,
    site_id: site,
    type_key: "post",
    status: "published",
    title: `Hello 世界 🚀 ${slug}`,
    slug,
    author_id: user,
    parent_id: parentId,
    locale: "",
    fields: JSON.stringify({
      price: 19.5,
      tags: ["a", "ü"],
      empty: null,
      big: 9007199254740991,
      flag: false,
    }),
    body: JSON.stringify([{ type: "paragraph", text: 'Line one\nLine two "quoted" \\ backslash' }]),
    plain_text: "Line one",
    html: "<p>Line one</p>",
    seo: "{}",
    meta: "{}",
    published_at: T,
    created_at: T,
    updated_at: T2,
    revision: 4,
  });
  await ins(db, "entries", entryRow(parent, "parent", null));
  await ins(db, "entries", entryRow(child, "child", parent));
  await ins(db, "entry_revisions", {
    id: id(16),
    entry_id: parent,
    kind: "revision",
    snapshot: JSON.stringify({ title: "Old" }),
    summary: "first",
    author_id: user,
    created_at: T,
  });
  await ins(db, "entry_locks", { entry_id: parent, user_id: user2, expires_at: T2 });
  const tax = id(17);
  await ins(db, "taxonomies", {
    id: tax,
    site_id: site,
    key: "category",
    label: "Category",
    hierarchical: true,
    applies_to: JSON.stringify(["post"]),
  });
  await ins(db, "terms", {
    id: id(18),
    taxonomy_id: tax,
    slug: "news",
    name: "News",
    description: "All the news",
  });
  await ins(db, "terms", {
    id: id(19),
    taxonomy_id: tax,
    parent_id: id(18),
    slug: "sub",
    name: "Sub",
  });
  await ins(db, "entry_terms", { entry_id: parent, term_id: id(19), position: 2 });
  await ins(db, "menus", {
    id: id(20),
    site_id: site,
    key: "main",
    label: "Main",
    items: JSON.stringify([{ label: "Home", href: "/" }]),
    updated_at: T,
  });
  await ins(db, "media_folders", { id: id(21), site_id: site, name: "Root" });
  await ins(db, "media_folders", { id: id(22), site_id: site, parent_id: id(21), name: "Child" });
  const media = id(23);
  await ins(db, "media", {
    id: media,
    site_id: site,
    folder_id: id(22),
    storage_key: "2026/10/a.png",
    filename: "a.png",
    mime_type: "image/png",
    size_bytes: 5_000_000_000,
    width: 800,
    height: 600,
    alt: "A",
    focal_x: 0.3333333333333333,
    focal_y: 0.5,
    blur_placeholder: "data:image/png;base64,AA==",
    content_hash: "abc",
    uploaded_by: user,
    created_at: T,
  });
  await ins(db, "media_variants", {
    media_id: media,
    width: 400,
    format: "webp",
    storage_key: "2026/10/a-400.webp",
    size_bytes: 1234,
  });
  await ins(db, "entry_media", { entry_id: parent, media_id: media, field: "featured" });
  await ins(db, "comments", {
    id: id(24),
    site_id: site,
    entry_id: parent,
    author_name: "Visitor",
    author_email_hash: "h",
    content: "First",
    created_at: T,
  });
  await ins(db, "comments", {
    id: id(25),
    site_id: site,
    entry_id: parent,
    parent_id: id(24),
    author_user_id: user2,
    author_name: "Zoë",
    content: "Reply",
    status: "approved",
    created_at: T2,
  });
  await ins(db, "settings", {
    site_id: site,
    key: "title",
    value: JSON.stringify("मेरी साइट"),
    revision: 3,
    updated_at: T,
  });
  const theme = id(26);
  await ins(db, "themes", {
    id: theme,
    site_id: site,
    key: "default",
    version: "1.0.0",
    source: "build",
    is_active: true,
    settings: "{}",
  });
  await ins(db, "theme_overrides", {
    theme_id: theme,
    template_key: "header",
    content: JSON.stringify({ blocks: [] }),
    draft: JSON.stringify({ blocks: [{ type: "paragraph" }] }),
    kind: "theme",
    name: "",
    base_hash: "h",
    base_version: "1.0.0",
    updated_at: T,
  });
  await ins(db, "theme_override_versions", {
    id: id(60),
    theme_id: theme,
    template_key: "header",
    content: JSON.stringify({ blocks: [] }),
    published_at: T,
    published_by: user,
  });
  await ins(db, "saved_sections", {
    id: id(61),
    site_id: site,
    name: "Opening hours",
    section_group: "contact",
    content: JSON.stringify([
      { id: "b1", type: "paragraph", props: {}, content: null, children: [] },
    ]),
    draft: null,
    created_by: user,
    created_at: T,
    updated_at: T,
  });
  await ins(db, "saved_section_versions", {
    id: id(62),
    section_id: id(61),
    content: JSON.stringify([]),
    published_at: T,
    published_by: user,
  });
  await ins(db, "email_log", {
    id: id(63),
    site_id: site,
    email_key: "test",
    to_address: "anna@example.com",
    subject: "A test",
    provider: "smtp",
    status: "sent",
    error: null,
    attempts: 1,
    created_at: T,
    last_attempt_at: T,
  });
  await ins(db, "email_texts", {
    site_id: site,
    email_key: "invitation",
    locale: "",
    subject: "Join us",
    body: "Hello {name}, [Join]({link})",
    updated_by: user,
    updated_at: T,
  });
  await ins(db, "known_devices", {
    user_id: user,
    device_hash: "a".repeat(64),
    description: "Firefox on Linux",
    created_at: T,
    last_seen_at: T,
  });
  await ins(db, "search_terms", {
    site_id: site,
    term: "sourdough",
    day: "2026-11-14",
    searches: 3,
    no_results: 1,
  });
  const ext = id(27);
  await ins(db, "extensions", {
    id: ext,
    site_id: site,
    key: "forms",
    kind: "plugin",
    version: "1.2.3",
    tier: "runtime",
    status: "enabled",
    license_key_hash: "lh",
    installed_at: T,
  });
  await ins(db, "extension_permissions", {
    extension_id: ext,
    permission: "entries.read",
    granted_by: user,
    granted_at: T,
  });
  await ins(db, "extension_storage", {
    extension_id: ext,
    collection: "c",
    key: "k",
    value: JSON.stringify({ n: 1 }),
    size_bytes: 7,
    updated_at: T,
  });
  await ins(db, "extension_settings", {
    extension_id: ext,
    key: "units",
    value: JSON.stringify("metric"),
    is_secret: false,
    updated_at: T,
  });
  await ins(db, "extension_pending_updates", {
    extension_id: ext,
    version: "1.3.0",
    code: "export default {};",
    integrity: "h",
    new_permissions: JSON.stringify(["entries.write"]),
    created_at: T,
  });
  await ins(db, "extension_previous_versions", {
    extension_id: ext,
    version: "1.2.2",
    code: "export default {};",
    integrity: "h",
    replaced_at: T,
  });
  await ins(db, "redirects", {
    id: id(28),
    site_id: site,
    from_path: "/old",
    to_path: "/new",
    status_code: 308,
    hit_count: 12,
    created_at: T,
  });
  await ins(db, "not_found_log", { site_id: site, path: "/missing", hits: 4, last_seen_at: T2 });
  await ins(db, "jobs", {
    id: id(29),
    site_id: site,
    kind: "publish",
    payload: JSON.stringify({ entry: parent }),
    run_at: T2,
    status: "done",
    attempts: 1,
    locked_by: "w1",
    locked_at: T,
    last_error: "none",
    created_at: T,
    finished_at: T2,
  });
  await ins(db, "audit_log", {
    id: id(30),
    site_id: site,
    actor_type: "user",
    actor_id: user,
    action: "entries.publish",
    target_type: "entry",
    target_id: parent,
    detail: JSON.stringify({ from: "draft" }),
    created_at: T,
  });
  await ins(db, "api_keys", {
    id: id(31),
    site_id: site,
    name: "Frontend",
    key_prefix: "oks_ab",
    key_hash: "kh",
    scopes: JSON.stringify(["entries.read"]),
    created_by: user,
    created_at: T,
    last_used_at: T2,
  });
  await ins(db, "cache_tags", {
    site_id: site,
    tag: "entry:" + parent,
    stale_at: T,
    expired_at: T2,
    updated_at: T2,
  });
  await ins(db, "cache_tags", { site_id: site, tag: "slug:home", updated_at: T });
}
