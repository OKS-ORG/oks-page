// Entries as the admin works with them (spec 03, sections 4 and 6; spec 02, sections 6 and 7): make a draft, load it, save it,
// list them. Every save checks who may do it, repairs the blocks, writes the HTML and the plain text with our own writer,
// and uses the revision rule, so two people editing the same entry cannot overwrite each other.
import { checkBlocks, type Block } from "@oks-page/content-safety";
import { newId, saveEntry, type SqlRunner } from "@oks-page/db";
import { writeBlocks } from "@oks-page/renderer";

/** Who is acting, and what they may do (their role's capabilities; spec 02, section 6). */
export interface Actor {
  userId: string;
  can(capability: string, typeKey?: string): boolean;
}

export type ContentStatus = "draft" | "published";
export const STATUSES: ContentStatus[] = ["draft", "published"];

/** Addresses the site keeps for itself (spec 03, "Slugs"). */
const RESERVED = new Set([
  "admin",
  "api",
  "_next",
  "feed",
  "sitemap.xml",
  "robots.txt",
  "favicon.ico",
  "not-found-handler",
  "test-form",
]);
const SLUG_PART = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const slugFromTitle = (title: string): string =>
  title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";

export type ContentErrorCode =
  "forbidden" | "not_found" | "invalid" | "slug_taken" | "conflict" | "no_such_type";

export type ContentResult<T> =
  | ({ ok: true } & T)
  | {
      ok: false;
      code: ContentErrorCode;
      message: string;
      field?: string;
      currentRevision?: number;
    };

const fail = (
  code: ContentErrorCode,
  message: string,
  extra: { field?: string; currentRevision?: number } = {},
): {
  ok: false;
  code: ContentErrorCode;
  message: string;
  field?: string;
  currentRevision?: number;
} => ({
  ok: false,
  code,
  message,
  ...extra,
});

/** The part of an address a content type puts in front of the slug, from its address rule ("/blog/{slug}" gives "blog/"). */
async function addressPrefix(
  runner: SqlRunner,
  siteId: string,
  type: string,
): Promise<string | null> {
  const row = (
    await runner.all(`select "url_rule" from "content_types" where "site_id" = ? and "key" = ?`, [
      siteId,
      type,
    ])
  )[0];
  if (!row) return null;
  const match = /^\/((?:[a-z0-9-]+\/)*)\{slug\}$/.exec(String(row["url_rule"]));
  return match ? match[1]! : null;
}

async function slugTaken(
  runner: SqlRunner,
  siteId: string,
  type: string,
  slug: string,
  exceptId?: string,
): Promise<boolean> {
  const rows = await runner.all(
    `select "id" from "entries" where "site_id" = ? and "type_key" = ? and "locale" = '' and "slug" = ? and "status" <> 'trash'`,
    [siteId, type, slug],
  );
  return rows.some((r) => String(r["id"]) !== exceptId);
}

const UPLOAD_PREFIX = "/uploads/";

/** The keys of the uploaded files a list of blocks points at (an image, a file, a video), in any nesting. */
export function uploadKeysIn(blocks: Block[]): string[] {
  const keys = new Set<string>();
  const walk = (list: Block[]) => {
    for (const block of list) {
      for (const name of ["src", "url"]) {
        const value = (block.props as Record<string, unknown>)[name];
        if (typeof value === "string" && value.startsWith(UPLOAD_PREFIX)) {
          const path = value.slice(UPLOAD_PREFIX.length).split(/[?#]/)[0]!;
          try {
            keys.add(path.split("/").map(decodeURIComponent).join("/"));
          } catch {
            keys.add(path);
          }
        }
      }
      walk(block.children);
    }
  };
  walk(blocks);
  return [...keys];
}

/** The library files these blocks use (an original or one of its sizes), for the "Used in" list of each file. */
async function usedMedia(
  runner: SqlRunner,
  siteId: string,
  blocks: Block[],
): Promise<{ mediaId: string; field: string }[]> {
  const ids = new Set<string>();
  for (const key of uploadKeysIn(blocks)) {
    const original = (
      await runner.all(`select "id" from "media" where "site_id" = ? and "storage_key" = ?`, [
        siteId,
        key,
      ])
    )[0];
    if (original) {
      ids.add(String(original["id"]));
      continue;
    }
    const size = (
      await runner.all(
        `select v."media_id" from "media_variants" v join "media" m on m."id" = v."media_id" where m."site_id" = ? and v."storage_key" = ?`,
        [siteId, key],
      )
    )[0];
    if (size) ids.add(String(size["media_id"]));
  }
  return [...ids].map((mediaId) => ({ mediaId, field: "body" }));
}

/** A new draft with a title and nothing else. The address is made from the title, with -2, -3 on a clash. */
export async function createDraft(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: { type: string; title: string },
  now: () => number = Date.now,
): Promise<ContentResult<{ id: string; slug: string; revision: number }>> {
  if (!actor.can("content.create", input.type))
    return fail("forbidden", "You may not add this kind of content.");
  const title = input.title.trim();
  if (!title) return fail("invalid", "Give it a title.", { field: "title" });
  if (title.length > 200)
    return fail("invalid", "The title can be at most 200 characters.", { field: "title" });
  const prefix = await addressPrefix(runner, siteId, input.type);
  if (prefix === null) return fail("no_such_type", "This kind of content does not exist.");
  const base = slugFromTitle(title);
  let part = RESERVED.has(base) ? `${base}-page` : base;
  for (let n = 2; await slugTaken(runner, siteId, input.type, prefix + part); n++)
    part = `${base}-${n}`;
  const at = new Date(now());
  const id = newId();
  await runner.all(
    `insert into "entries" ("id", "site_id", "type_key", "status", "title", "slug", "author_id", "fields", "body", "plain_text", "html", "seo", "meta", "created_at", "updated_at")
     values (?, ?, ?, 'draft', ?, ?, ?, '{}', ?, '', '', '{}', '{}', ?, ?)`,
    [
      id,
      siteId,
      input.type,
      title,
      prefix + part,
      actor.userId,
      JSON.stringify({ version: 1, blocks: [] }),
      at,
      at,
    ],
  );
  return { ok: true, id, slug: prefix + part, revision: 1 };
}

export interface EntryForEdit {
  id: string;
  type: string;
  title: string;
  /** The address without the type's prefix ("hello-world" for "blog/hello-world"). */
  slugPart: string;
  /** What the type puts in front of the slug ("blog/"), or "". */
  prefix: string;
  status: string;
  revision: number;
  blocks: Block[];
  authorId: string;
}

const mayEdit = (actor: Actor, type: string, authorId: string): boolean =>
  actor.can("content.edit_any", type) ||
  (actor.can("content.edit_own", type) && authorId === actor.userId);

const parseJson = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) : value;

export async function loadForEdit(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<ContentResult<{ entry: EntryForEdit }>> {
  const row = (
    await runner.all(
      `select "id", "type_key", "title", "slug", "status", "revision", "body", "author_id" from "entries" where "id" = ? and "site_id" = ? and "status" <> 'trash'`,
      [id, siteId],
    )
  )[0];
  if (!row) return fail("not_found", "This entry does not exist.");
  const type = String(row["type_key"]);
  const authorId = String(row["author_id"]);
  if (!mayEdit(actor, type, authorId)) return fail("forbidden", "You may not edit this.");
  const prefix = (await addressPrefix(runner, siteId, type)) ?? "";
  const slug = String(row["slug"]);
  const body = parseJson(row["body"]) as { blocks?: Block[] } | Block[] | null;
  const blocks = Array.isArray(body) ? body : Array.isArray(body?.blocks) ? body.blocks : [];
  return {
    ok: true,
    entry: {
      id,
      type,
      title: String(row["title"]),
      slugPart: slug.startsWith(prefix) ? slug.slice(prefix.length) : slug,
      prefix,
      status: String(row["status"]),
      revision: Number(row["revision"]),
      blocks,
      authorId,
    },
  };
}

export interface SaveInput {
  title: string;
  slugPart: string;
  status: string;
  blocks: unknown;
  /** The revision the editor loaded. */
  revision: number;
}

export interface SavedContent {
  revision: number;
  /** One entry per thing the block checks repaired (an unsafe link, a duplicate id, ...). */
  repairs: string[];
  /** Block types the HTML writer does not draw (a plugin's block, for example). */
  skippedBlocks: string[];
  slug: string;
  status: string;
}

export async function saveContent(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
  input: SaveInput,
  now: () => number = Date.now,
): Promise<ContentResult<SavedContent>> {
  const row = (
    await runner.all(
      `select "type_key", "author_id", "slug", "published_at" from "entries" where "id" = ? and "site_id" = ? and "status" <> 'trash'`,
      [id, siteId],
    )
  )[0];
  if (!row) return fail("not_found", "This entry does not exist.");
  const type = String(row["type_key"]);
  const authorId = String(row["author_id"]);
  if (!mayEdit(actor, type, authorId)) return fail("forbidden", "You may not edit this.");

  const title = String(input.title ?? "").trim();
  if (!title) return fail("invalid", "Give it a title.", { field: "title" });
  if (title.length > 200)
    return fail("invalid", "The title can be at most 200 characters.", { field: "title" });
  const slugPart = String(input.slugPart ?? "").trim();
  if (!SLUG_PART.test(slugPart))
    return fail(
      "invalid",
      "The address can only have lower-case letters, numbers and single hyphens.",
      {
        field: "slug",
      },
    );
  if (RESERVED.has(slugPart))
    return fail("invalid", "This address is kept for the site itself.", { field: "slug" });
  if (!(STATUSES as string[]).includes(input.status))
    return fail("invalid", "Choose draft or published.", { field: "status" });
  const publishing = input.status === "published";
  const mayPublish =
    actor.can("content.publish_any", type) ||
    (actor.can("content.publish_own", type) && authorId === actor.userId);
  if (publishing && !mayPublish)
    return fail("forbidden", "You may not publish this.", { field: "status" });

  const prefix = (await addressPrefix(runner, siteId, type)) ?? "";
  const slug = prefix + slugPart;
  if (slug !== String(row["slug"]) && (await slugTaken(runner, siteId, type, slug, id)))
    return fail("slug_taken", "Another entry already has this address.", { field: "slug" });

  // The same checks every other path uses, then our own writer for the stored HTML and text.
  const checked = checkBlocks({ version: 1, blocks: input.blocks });
  const written = writeBlocks(checked.body.blocks);
  const at = new Date(now());
  const saved = await saveEntry(runner, {
    entryId: id,
    fromRevision: input.revision,
    changes: {
      title,
      slug,
      status: input.status,
      body: checked.body,
      html: written.html,
      plain_text: written.plainText,
      ...(publishing && row["published_at"] == null ? { published_at: at } : {}),
    },
    // Which library files the page uses, so a file in use is not deleted by mistake.
    media: await usedMedia(runner, siteId, checked.body.blocks),
    now: at,
  });
  if (!saved.ok) {
    if (saved.reason === "conflict")
      return fail(
        "conflict",
        "Someone else saved this while you were editing. Reload to see their version.",
        {
          currentRevision: saved.currentRevision,
        },
      );
    return fail("not_found", "This entry does not exist.");
  }
  return {
    ok: true,
    revision: saved.revision,
    repairs: checked.repairs,
    skippedBlocks: written.skipped,
    slug,
    status: input.status,
  };
}

export interface ListedEntry {
  id: string;
  title: string;
  slug: string;
  status: string;
  authorName: string;
  updatedAt: string;
}

/** The entries of one type, newest first. Someone who may only edit their own sees only theirs. */
export async function listEntries(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  type: string,
  limit = 200,
): Promise<ListedEntry[]> {
  const everyone = actor.can("content.edit_any", type);
  if (!everyone && !actor.can("content.edit_own", type)) return [];
  const rows = await runner.all(
    `select e."id", e."title", e."slug", e."status", e."updated_at", u."name" as author_name
       from "entries" e left join "users" u on u."id" = e."author_id"
      where e."site_id" = ? and e."type_key" = ? and e."status" <> 'trash' ${everyone ? "" : 'and e."author_id" = ?'}
      order by e."updated_at" desc, e."id" limit ${Math.min(Math.max(Math.trunc(limit), 1), 500)}`,
    everyone ? [siteId, type] : [siteId, type, actor.userId],
  );
  return rows.map((r) => ({
    id: String(r["id"]),
    title: String(r["title"]),
    slug: String(r["slug"]),
    status: String(r["status"]),
    authorName: String(r["author_name"] ?? ""),
    updatedAt: (r["updated_at"] instanceof Date
      ? r["updated_at"]
      : new Date(Number(r["updated_at"]))
    ).toISOString(),
  }));
}
