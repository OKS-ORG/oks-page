// Entries as the admin works with them (spec 03, sections 4 and 6; spec 02, sections 6 and 7): make a draft, load it, save it,
// list them. Every save checks who may do it, repairs the blocks, writes the HTML and the plain text with our own writer,
// and uses the revision rule, so two people editing the same entry cannot overwrite each other.
import { newPostDefaults } from "./site-settings.js";
import {
  checkBlocks,
  hasLock,
  LAYOUT_ONLY,
  lockViolation,
  type Block,
} from "@oks-page/content-safety";
import { newId, saveEntry, type SqlRunner } from "@oks-page/db";
import { recordSlugChange } from "./redirects.js";
import { sectionsForContent, writeContentBlocks } from "./saved-sections.js";
import { canonicalJson, pruneRevisions, summarise } from "./revision-parts.js";
import { loadScreenSizes } from "./screen-sizes.js";
import { addCovers } from "./video-covers.js";

/** Who is acting, and what they may do (their role's capabilities; spec 02, section 6). */
import {
  checkRelations,
  cleanFieldValues,
  fieldsOfType,
  pictureMedia,
  type FieldDef,
} from "./content-types.js";

export interface Actor {
  userId: string;
  can(capability: string, typeKey?: string): boolean;
}

/** "pending" is "waiting for review": a writer who may not publish hands the entry to an editor (spec 04, workflow). */
export type ContentStatus = "draft" | "pending" | "scheduled" | "published";
export const STATUSES: ContentStatus[] = ["draft", "pending", "scheduled", "published"];

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
  "maintenance-handler",
  "search",
  "preview",
  "feed.xml",
  "atom.xml",
  "test-form",
  "fonts",
]);
// A part of an address is made of letters, combining marks and numbers of any script, joined by single hyphens
// (spec 08, section 3). The marks belong to the letters: without them Hindi "नमस्ते" falls apart.
const SLUG_CHARS = String.raw`[\p{L}\p{N}\p{M}]`;
const SLUG_PART = new RegExp(`^${SLUG_CHARS}+(?:-${SLUG_CHARS}+)*$`, "u");
const NOT_SLUG = /[^\p{L}\p{N}\p{M}]+/gu;

/**
 * True for an address part the site accepts: lower case, in the composed Unicode form (NFC), and made only of letters,
 * marks and numbers joined by single hyphens. "café-münster" and "नमस्ते-दुनिया" pass; "Café" and "a--b" do not.
 */
export const isSlugPart = (slug: string): boolean =>
  slug === slug.normalize("NFC") && slug === slug.toLowerCase() && SLUG_PART.test(slug);

/**
 * An address part made from a title: composed (NFC), lower case, apostrophes removed, every run of anything that is not a
 * letter, mark or number becomes one hyphen, at most 80 characters, no hyphen at either end. Accents and other scripts
 * are kept ("Café Münster" gives "café-münster", "नमस्ते दुनिया" gives "नमस्ते-दुनिया"). A title with nothing usable
 * gives "untitled".
 */
export const slugFromTitle = (title: string): string => {
  const made = title
    .normalize("NFC")
    .toLowerCase()
    .normalize("NFC")
    .replace(/['’]/g, "")
    .replace(NOT_SLUG, "-")
    .replace(/^-+|-+$/g, "");
  // Cut by characters, not by code units, so a letter outside the basic plane is never split.
  return Array.from(made).slice(0, 80).join("").replace(/-+$/, "") || "untitled";
};

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
  input: { type: string; title: string; editor?: "writing" | "layout" },
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
  // A new post starts in the default category, with the default layout (Settings > Writing).
  const defaults =
    input.type === "post"
      ? await newPostDefaults(runner, siteId)
      : { categoryId: null, layout: "" };
  await runner.all(
    `insert into "entries" ("id", "site_id", "type_key", "status", "title", "slug", "author_id", "fields", "body", "plain_text", "html", "seo", "meta", "created_at", "updated_at")
     values (?, ?, ?, 'draft', ?, ?, ?, '{}', ?, '', '', '{}', ?, ?, ?)`,
    [
      id,
      siteId,
      input.type,
      title,
      prefix + part,
      actor.userId,
      JSON.stringify({ version: 1, blocks: [] }),
      // Which editor opens it is chosen by the caller (the screen that adds an entry); without a choice it is the writing editor.
      JSON.stringify({
        ...(defaults.layout ? { layout: defaults.layout } : {}),
        ...(input.editor === "layout" ? { editor: "layout" } : {}),
      }),
      at,
      at,
    ],
  );
  if (defaults.categoryId)
    await runner.all(
      `insert into "entry_terms" ("entry_id", "term_id", "position") values (?, ?, 0)`,
      [id, defaults.categoryId],
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
  /** When a scheduled entry goes live (ISO time), or null. */
  scheduledAt: string | null;
  revision: number;
  blocks: Block[];
  authorId: string;
  /** Which editor opens it: the writing editor, or the layout editor (spec 06, section 13). */
  editor: "writing" | "layout";
  /** The custom fields of this entry's type, and the values saved in them. */
  fieldDefs: FieldDef[];
  fieldValues: Record<string, unknown>;
}

const mayEdit = (actor: Actor, type: string, authorId: string): boolean =>
  actor.can("content.edit_any", type) ||
  (actor.can("content.edit_own", type) && authorId === actor.userId);

const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(Number(value)));

const parseJson = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) : value;

/** Which editor opens an entry: the one it chose, or the layout editor when its body holds blocks only that editor draws. */
export function editorOf(meta: unknown, blocks: Block[]): "writing" | "layout" {
  const chosen =
    meta !== null && typeof meta === "object" ? (meta as { editor?: unknown }).editor : undefined;
  const onlyLayout = (list: Block[]): boolean =>
    list.some((b) => LAYOUT_ONLY.has(b.type) || onlyLayout(b.children ?? []));
  return chosen === "layout" || onlyLayout(blocks) ? "layout" : "writing";
}

export async function loadForEdit(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<ContentResult<{ entry: EntryForEdit }>> {
  const row = (
    await runner.all(
      `select "id", "type_key", "title", "slug", "status", "revision", "body", "meta", "author_id", "scheduled_at", "fields" from "entries" where "id" = ? and "site_id" = ? and "status" <> 'trash'`,
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
  const fieldDefs = await fieldsOfType(runner, siteId, type);
  return {
    ok: true,
    entry: {
      id,
      type,
      title: String(row["title"]),
      slugPart: slug.startsWith(prefix) ? slug.slice(prefix.length) : slug,
      prefix,
      status: String(row["status"]),
      scheduledAt: row["scheduled_at"] == null ? null : toDate(row["scheduled_at"]).toISOString(),
      revision: Number(row["revision"]),
      blocks,
      authorId,
      editor: editorOf(parseJson(row["meta"]), blocks),
      fieldDefs,
      fieldValues: (parseJson(row["fields"]) ?? {}) as Record<string, unknown>,
    },
  };
}

export interface SaveInput {
  title: string;
  slugPart: string;
  status: string;
  /** When to publish, for the status "scheduled" (an ISO time in the future). */
  scheduledAt?: string | null;
  blocks: unknown;
  /** The revision the editor loaded. */
  revision: number;
  /** The values of the custom fields of the entry's type (a type without fields ignores it). */
  fields?: unknown;
}

export interface SavedContent {
  revision: number;
  /** One entry per thing the block checks repaired (an unsafe link, a duplicate id, ...). */
  repairs: string[];
  /** Block types the HTML writer does not draw (a plugin's block, for example). */
  skippedBlocks: string[];
  slug: string;
  status: string;
  scheduledAt: string | null;
}

/** The part of an entry a plugin sees when a save runs its hooks (spec 04, section 7). */
export interface HookEntry {
  id: string;
  status: string;
  title: string;
  plainText: string;
  meta: Record<string, unknown>;
  typeKey: string;
  authorId: string;
}

/**
 * What the plugins do in a save. The core knows nothing of how they run: the site passes these three functions, and a
 * site with no plugins passes nothing (spec 04, sections 5.3 and 7).
 */
export interface SaveHooks {
  /** A filter: it may change the title, and add values of its own to the entry's meta under the plugin's id. */
  beforeSave?(
    entry: HookEntry,
  ): Promise<{ title?: string; plugins?: Record<string, Record<string, unknown>> } | null>;
  /** A check before an entry goes live: only an explicit refusal blocks it. */
  beforePublish?(
    entry: HookEntry,
  ): Promise<{ allowed: true } | { allowed: false; message: string }>;
  /** An action after the save: not waited for. */
  afterSave?(entry: HookEntry): void;
}

export async function saveContent(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
  input: SaveInput,
  now: () => number = Date.now,
  options: { summary?: string; publishAnyway?: boolean; hooks?: SaveHooks } = {},
): Promise<ContentResult<SavedContent>> {
  const row = (
    await runner.all(
      `select "type_key", "author_id", "slug", "published_at", "title", "status", "plain_text", "body", "meta", "scheduled_at", "fields" from "entries" where "id" = ? and "site_id" = ? and "status" <> 'trash'`,
      [id, siteId],
    )
  )[0];
  if (!row) return fail("not_found", "This entry does not exist.");
  const type = String(row["type_key"]);
  const authorId = String(row["author_id"]);
  if (!mayEdit(actor, type, authorId)) return fail("forbidden", "You may not edit this.");
  // Locked parts of a page (spec 06, section 5): only a designer may change them, and the server decides, not the screen.
  if (!actor.can("themes.manage")) {
    const old = parseJson(row["body"]) as { blocks?: Block[] } | Block[] | null;
    const before = Array.isArray(old) ? old : Array.isArray(old?.blocks) ? old.blocks : [];
    if (hasLock(before) || JSON.stringify(input.blocks ?? null).includes('"locked"')) {
      const violation = lockViolation(
        before,
        checkBlocks(
          { version: 1, blocks: input.blocks },
          { breakpoints: await loadScreenSizes(runner, siteId) },
        ).body.blocks,
      );
      if (violation) return fail("forbidden", violation, { field: "blocks" });
    }
  }

  let title = String(input.title ?? "").trim();
  if (!title) return fail("invalid", "Give it a title.", { field: "title" });
  if (title.length > 200)
    return fail("invalid", "The title can be at most 200 characters.", { field: "title" });
  const slugPart = String(input.slugPart ?? "").trim();
  if (!isSlugPart(slugPart))
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
    return fail("invalid", "Choose draft, waiting for review, scheduled or published.", {
      field: "status",
    });
  const publishing = input.status === "published";
  const mayPublish =
    actor.can("content.publish_any", type) ||
    (actor.can("content.publish_own", type) && authorId === actor.userId);
  if (input.status !== "draft" && input.status !== "pending" && !mayPublish)
    return fail("forbidden", "You may not publish this.", { field: "status" });
  let scheduledAt: Date | null = null;
  if (input.status === "scheduled") {
    const when = input.scheduledAt ? new Date(String(input.scheduledAt)) : null;
    if (!when || Number.isNaN(when.getTime()))
      return fail("invalid", "Choose when to publish it.", { field: "scheduledAt" });
    if (when.getTime() <= now())
      return fail("invalid", "Choose a time in the future.", { field: "scheduledAt" });
    scheduledAt = when;
  }
  // Who scheduled it is kept in the entry's meta, because the publishing job acts with their permission.
  const oldMeta = (parseJson(row["meta"]) ?? {}) as Record<string, unknown>;
  const meta: Record<string, unknown> = { ...oldMeta };
  if (scheduledAt) meta["scheduledBy"] = actor.userId;
  else delete meta["scheduledBy"];
  // An administrator who scheduled the page and set the publish check aside: the job does not hold it back again.
  if (scheduledAt && options.publishAnyway === true) meta["publishAnyway"] = true;
  else delete meta["publishAnyway"];

  const prefix = (await addressPrefix(runner, siteId, type)) ?? "";
  const slug = prefix + slugPart;
  if (slug !== String(row["slug"]) && (await slugTaken(runner, siteId, type, slug, id)))
    return fail("slug_taken", "Another entry already has this address.", { field: "slug" });

  // The same checks every other path uses, then our own writer for the stored HTML and text.
  const checked = checkBlocks(
    { version: 1, blocks: input.blocks },
    { breakpoints: await loadScreenSizes(runner, siteId) },
  );
  // A video block gets the picture it shows before a click (fetched once, kept in Media); a failure only leaves it out.
  await addCovers(checked.body.blocks, siteId, actor);
  // A saved section linked in the page is put in place before the HTML and the text are written.
  const linked = await sectionsForContent(runner, siteId, checked.body.blocks);
  if (!linked.ok) return fail("invalid", linked.message, { field: "blocks" });
  const written = writeContentBlocks(checked.body.blocks, linked.sections);
  // The custom fields of this type: checked and cleaned, or the save is refused with the field named.
  const defs = await fieldsOfType(runner, siteId, type);
  let fieldChange: { fields: Record<string, unknown> } | undefined;
  if (defs.length > 0 && input.fields !== undefined) {
    const cleaned = cleanFieldValues(defs, input.fields);
    if (!cleaned.ok) return fail("invalid", cleaned.message, { field: cleaned.field });
    fieldChange = { fields: cleaned.fields };
    const linked = await checkRelations(runner, siteId, defs, cleaned.fields);
    if (!linked.ok) return fail("invalid", linked.message, { field: linked.field });
  }
  // The files the picture fields use: a value being saved must be an image of this library; an older one that has
  // since gone is just left out.
  const pictures = await pictureMedia(
    runner,
    siteId,
    defs,
    fieldChange?.fields ?? (parseJson(row["fields"]) as Record<string, unknown> | null) ?? {},
    fieldChange !== undefined,
  );
  if (!pictures.ok) return fail("invalid", pictures.message, { field: pictures.field });
  // The plugins' hooks (spec 04, section 7). They run only now, when the save is otherwise sure to go ahead, and only for
  // a person's own save. A refusal from a plugin that worked stops going live; anything else a plugin does wrong is
  // left out and the save carries on without it.
  const hooks = options.hooks;
  const hookEntry = (): HookEntry => ({
    id,
    status: input.status,
    title,
    plainText: written.plainText,
    meta: structuredClone(meta),
    typeKey: type,
    authorId,
  });
  if (hooks?.beforePublish && publishing && String(row["status"]) !== "published") {
    const verdict = await hooks.beforePublish(hookEntry());
    if (!verdict.allowed) return fail("invalid", verdict.message, { field: "status" });
  }
  if (hooks?.beforeSave) {
    const changed = await hooks.beforeSave(hookEntry());
    if (changed) {
      if (typeof changed.title === "string") {
        const t = changed.title.trim();
        if (t && t.length <= 200) title = t;
      }
      if (changed.plugins) {
        const mine =
          meta["plugins"] !== null && typeof meta["plugins"] === "object"
            ? { ...(meta["plugins"] as Record<string, unknown>) }
            : {};
        for (const [pluginId, values] of Object.entries(changed.plugins)) {
          // Each plugin keeps its own part of the meta, and a part cannot grow past a few kilobytes.
          if (JSON.stringify(values).length <= 4096) mine[pluginId] = values;
        }
        meta["plugins"] = mine;
      }
    }
  }
  const at = new Date(now());
  const saved = await saveEntry(runner, {
    entryId: id,
    fromRevision: input.revision,
    changes: {
      title,
      slug,
      status: input.status,
      scheduled_at: scheduledAt,
      ...(JSON.stringify(meta) !== JSON.stringify(oldMeta) ? { meta } : {}),
      body: checked.body,
      ...fieldChange,
      html: written.html,
      plain_text: written.plainText,
      ...(publishing && row["published_at"] == null ? { published_at: at } : {}),
    },
    // Which library files the page uses, so a file in use is not deleted by mistake.
    media: [...(await usedMedia(runner, siteId, checked.body.blocks)), ...pictures.media],
    // A full copy of this save, with a short summary of what changed.
    snapshot: {
      id: newId(),
      authorId: actor.userId,
      summary:
        options.summary ??
        summarise(
          {
            title: String(row["title"]),
            slug: String(row["slug"]),
            status: String(row["status"]),
            scheduledAt:
              row["scheduled_at"] == null ? null : toDate(row["scheduled_at"]).toISOString(),
            plainText: String(row["plain_text"] ?? ""),
            bodyJson: canonicalJson(parseJson(row["body"])),
          },
          {
            title,
            slug,
            status: input.status,
            scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
            plainText: written.plainText,
            bodyJson: canonicalJson(checked.body),
          },
        ),
      content: { title, slug, status: input.status, body: checked.body },
    },
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
  await pruneRevisions(runner, id, at.getTime());
  // A save that removed or cut content leaves a line in the log, so a loss is never silent.
  const lost = checked.repairs.filter(
    (r) => r === "removed_invalid_block" || r === "cut_document_size",
  );
  if (lost.length > 0)
    await runner.all(
      `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id",
        "detail", "created_at") values (?, ?, 'user', ?, 'content.repaired', 'entry', ?, ?, ?)`,
      [
        newId(),
        siteId,
        actor.userId,
        id,
        JSON.stringify({ removed: lost.length, repairs: [...new Set(lost)] }),
        at,
      ],
    );
  // A published page that gets a new address keeps its old address working (a 301, chains collapsed).
  if (
    String(row["status"]) === "published" &&
    input.status === "published" &&
    slug !== String(row["slug"])
  )
    await recordSlugChange(runner, siteId, String(row["slug"]), slug);
  // The unsaved copy this person had is now in the saved page.
  await runner.all(
    `delete from "entry_revisions" where "entry_id" = ? and "author_id" = ? and "kind" = 'autosave'`,
    [id, actor.userId],
  );
  if (hooks?.afterSave) {
    try {
      hooks.afterSave({ ...hookEntry(), meta: structuredClone(meta) });
    } catch {
      // a plugin's reaction never changes the answer to the person who saved
    }
  }
  return {
    ok: true,
    revision: saved.revision,
    repairs: checked.repairs,
    skippedBlocks: written.skipped,
    slug,
    status: input.status,
    scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
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
