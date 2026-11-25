// The site bundle (spec 11, section 9; AG-70 to AG-76, AG-87): one file that holds a whole site's pages, posts, media,
// menus, design and look, to give a site to its owner or to start a copy of it. It is a .tgz with
//   manifest.json   the format number, the site's name, and every other file's path, SHA-256 and size
//   content.json    the rows of the site's content (types, entries, terms, menus, media records, redirects, saved sections, the layouts)
//   settings.json   a short list of settings that describe the site (language, icon, reading, writing, SEO, media, look)
//   media/<key>     every uploaded file and its sizes
//
// What is NOT inside, on purpose: people and their sign-in data, comments, the history of changes, plugins and what they
// stored, email and publish settings, the licence, privacy records and statistics, and every secret. Settings are taken
// from a list of allowed names (never "everything except the secrets"), so a setting added later stays out until it is
// put on the list. The importing site sets its own secrets.
//
// Nothing is trusted on the way in: the file list is checked against the files (a changed, missing or extra file stops
// the import), every path must stay inside the bundle, every uploaded file is checked again like a new upload, and
// nothing is changed until all checks have passed.
import { createHash } from "node:crypto";
import {
  assertSafeKey,
  checkUpload,
  cleanSvg,
  SvgRefused,
  type StorageAdapter,
} from "@oks-page/media";
import { columnsOf, newId, readRows, writeRows, type SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import { readTarGz, writeTarGz } from "./tar.js";

export const BUNDLE_KIND = "site-bundle";
export const BUNDLE_FORMAT = 1;
/** The most a bundle may hold once unpacked (the files and their headers). */
export const BUNDLE_MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
/** The most one uploaded file inside a bundle may be. */
const FILE_MAX_BYTES = 200 * 1024 * 1024;

/** The settings a bundle carries. Everything else stays with the site it is on. */
export const BUNDLE_SETTINGS = [
  "site-language",
  "site-icon",
  "theme",
  "reading",
  "writing",
  "seo",
  "media",
  "owner-fonts",
  "screen-sizes",
  "oks-color-mode",
  "blocked-styles",
  "consent_texts",
] as const;

/** Tables of the content, in an order where a table comes after the tables it points at. */
const CONTENT_TABLES = [
  "content_types",
  "field_definitions",
  "taxonomies",
  "terms",
  "entries",
  "entry_terms",
  "media_folders",
  "media",
  "media_variants",
  "entry_media",
  "menus",
  "redirects",
  "saved_sections",
  "theme_overrides",
] as const;
type ContentTable = (typeof CONTENT_TABLES)[number];

/** Columns that name a person of the site the bundle came from; the importing site puts its own person there. */
const PERSON: Partial<Record<ContentTable, string[]>> = {
  entries: ["author_id"],
  media: ["uploaded_by"],
  saved_sections: ["created_by"],
};

export type BundleFail = { ok: false; code: "forbidden" | "invalid"; message: string };
const fail = (code: BundleFail["code"], message: string): BundleFail => ({
  ok: false,
  code,
  message,
});

type Row = Record<string, unknown>;

interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
}
export interface BundleManifest {
  kind: typeof BUNDLE_KIND;
  format: number;
  siteName: string;
  createdAt: string;
  files: ManifestFile[];
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const inList = (n: number) => Array.from({ length: n }, () => "?").join(", ");

export interface BundleCounts {
  entries: number;
  media: number;
  menus: number;
  settings: number;
}

// ----------------------------------------------------------------------------------------------------------------- export

/**
 * Makes the bundle of a site. A file of the library that is missing from storage is left out (with its record) and named in
 * `skipped`, rather than stopping the whole export.
 */
export async function exportBundle(
  runner: SqlRunner,
  storage: StorageAdapter,
  actor: Actor,
  siteId: string,
  now: () => number = Date.now,
): Promise<
  | { ok: true; archive: Buffer; fileName: string; counts: BundleCounts; skipped: string[] }
  | BundleFail
> {
  if (!actor.can("export")) return fail("forbidden", "You may not export the site.");
  const site = await runner.all(`select "name" from "sites" where "id" = ?`, [siteId]);
  if (site.length === 0) return fail("invalid", "This site does not exist.");

  const own = '"site_id" = ?';
  const entryIds = `select "id" from "entries" where "site_id" = ? and "status" <> 'trash'`;
  const tables: Record<string, Row[]> = {};
  tables["content_types"] = await readRows(runner, "content_types", own, [siteId]);
  tables["field_definitions"] = await readRows(
    runner,
    "field_definitions",
    `"content_type_id" in (select "id" from "content_types" where ${own})`,
    [siteId],
  );
  tables["taxonomies"] = await readRows(runner, "taxonomies", own, [siteId]);
  tables["terms"] = await readRows(
    runner,
    "terms",
    `"taxonomy_id" in (select "id" from "taxonomies" where ${own})`,
    [siteId],
  );
  const entries = await readRows(runner, "entries", `${own} and "status" <> 'trash'`, [siteId]);
  const entryKnown = new Set(entries.map((e) => e["id"]));
  tables["entries"] = entries.map((e) => ({
    ...e,
    author_id: null,
    // A page whose parent was thrown away stands on its own.
    parent_id: entryKnown.has(e["parent_id"]) ? e["parent_id"] : null,
  }));
  tables["entry_terms"] = await readRows(runner, "entry_terms", `"entry_id" in (${entryIds})`, [
    siteId,
  ]);
  tables["media_folders"] = await readRows(runner, "media_folders", own, [siteId]);

  // The files first, so a record whose file is gone is left out with everything that points at it.
  const files: { path: string; data: Buffer }[] = [];
  const skipped: string[] = [];
  const media: Row[] = [];
  const keepVariants: Row[] = [];
  const variants = await readRows(
    runner,
    "media_variants",
    `"media_id" in (select "id" from "media" where ${own})`,
    [siteId],
  );
  for (const m of await readRows(runner, "media", own, [siteId])) {
    const mine = variants.filter((v) => v["media_id"] === m["id"]);
    const wanted = [String(m["storage_key"]), ...mine.map((v) => String(v["storage_key"]))];
    const got: { path: string; data: Buffer }[] = [];
    let complete = true;
    for (const key of wanted) {
      try {
        got.push({ path: `media/${key}`, data: Buffer.from(await storage.get(key)) });
      } catch {
        complete = false;
        break;
      }
    }
    if (!complete) {
      skipped.push(String(m["filename"]));
      continue;
    }
    for (const g of got) if (!files.some((f) => f.path === g.path)) files.push(g);
    media.push({ ...m, uploaded_by: null });
    keepVariants.push(...mine);
  }
  const mediaKnown = new Set(media.map((m) => m["id"]));
  tables["media"] = media;
  tables["media_variants"] = keepVariants;
  tables["entry_media"] = (
    await readRows(runner, "entry_media", `"entry_id" in (${entryIds})`, [siteId])
  ).filter((r) => mediaKnown.has(r["media_id"]));
  tables["menus"] = await readRows(runner, "menus", own, [siteId]);
  tables["redirects"] = await readRows(runner, "redirects", own, [siteId]);
  tables["saved_sections"] = (await readRows(runner, "saved_sections", own, [siteId])).map((s) => ({
    ...s,
    created_by: null,
  }));
  // Only themes that come with the product travel; an installed theme is installed again on the new site.
  const themes = await readRows(runner, "themes", `${own} and "source" = 'build'`, [siteId]);
  tables["themes"] = themes;
  tables["theme_overrides"] =
    themes.length === 0
      ? []
      : await readRows(
          runner,
          "theme_overrides",
          `"theme_id" in (${inList(themes.length)})`,
          themes.map((t) => t["id"]),
        );

  const settings: Record<string, unknown> = {};
  for (const r of await readRows(
    runner,
    "settings",
    `${own} and "key" in (${inList(BUNDLE_SETTINGS.length)})`,
    [siteId, ...BUNDLE_SETTINGS],
  ))
    settings[String(r["key"])] = r["value"];

  const all = [
    { path: "content.json", data: json({ tables }) },
    { path: "settings.json", data: json({ settings }) },
    ...files,
  ];
  const created = new Date(now()).toISOString();
  const manifest: BundleManifest = {
    kind: BUNDLE_KIND,
    format: BUNDLE_FORMAT,
    siteName: String(site[0]!["name"]),
    createdAt: created,
    files: all.map((f) => ({ path: f.path, sha256: sha256(f.data), size: f.data.length })),
  };
  const archive = writeTarGz([{ path: "manifest.json", data: json(manifest) }, ...all]);
  const day = created.slice(0, 10);
  return {
    ok: true,
    archive,
    fileName: `site-bundle-${day}.tgz`,
    counts: {
      entries: entries.length,
      media: media.length,
      menus: tables["menus"]!.length,
      settings: Object.keys(settings).length,
    },
    skipped,
  };
}

// ----------------------------------------------------------------------------------------------------------------- checks

/** A path inside the bundle: plain names between slashes, no way out of the folder. */
function safePath(path: string): boolean {
  if (path === "" || path.length > 512 || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export interface CheckedBundle {
  manifest: BundleManifest;
  tables: Record<ContentTable, Row[]> & { themes: Row[] };
  settings: Record<string, unknown>;
  /** Every uploaded file, by its storage key, already checked (a picture of a site is stored cleaned). */
  media: Map<string, Uint8Array>;
}

/** Reads and checks a bundle completely, without touching any site. */
export async function checkBundle(
  archive: Buffer,
  maxUnpackedBytes: number = BUNDLE_MAX_UNPACKED_BYTES,
): Promise<{ ok: true; bundle: CheckedBundle } | BundleFail> {
  const tar = readTarGz(archive, maxUnpackedBytes);
  if (!tar.ok) return fail("invalid", tar.error);
  const found = new Map<string, Buffer>();
  for (const e of tar.entries) {
    if (e.kind === "dir") continue;
    if (e.kind === "other")
      return fail("invalid", "The bundle holds a link or a special file, which is not allowed.");
    if (!safePath(e.path))
      return fail(
        "invalid",
        `The bundle holds a file with a path that is not allowed: ${e.path.slice(0, 80)}`,
      );
    if (found.has(e.path)) return fail("invalid", `The bundle holds ${e.path} twice.`);
    found.set(e.path, e.data);
  }
  const manifestRaw = found.get("manifest.json");
  if (!manifestRaw)
    return fail("invalid", "This is not a site bundle: its list of files is missing.");
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestRaw.toString("utf8"));
  } catch {
    return fail("invalid", "This is not a site bundle: its list of files cannot be read.");
  }
  if (!isObject(manifestValue) || manifestValue["kind"] !== BUNDLE_KIND)
    return fail("invalid", "This is not a site bundle.");
  const format = manifestValue["format"];
  if (typeof format !== "number" || !Number.isInteger(format) || format < 1)
    return fail("invalid", "This is not a site bundle: its format number is missing.");
  if (format > BUNDLE_FORMAT)
    return fail(
      "invalid",
      "This bundle was made by a newer version. Update this site first, then import it.",
    );
  const list = manifestValue["files"];
  if (!Array.isArray(list))
    return fail("invalid", "This is not a site bundle: its list of files is missing.");
  const listed = new Map<string, ManifestFile>();
  for (const f of list) {
    if (
      !isObject(f) ||
      typeof f["path"] !== "string" ||
      typeof f["sha256"] !== "string" ||
      typeof f["size"] !== "number"
    )
      return fail("invalid", "This is not a site bundle: its list of files is damaged.");
    if (!safePath(f["path"]) || f["path"] === "manifest.json")
      return fail(
        "invalid",
        `The list holds a path that is not allowed: ${f["path"].slice(0, 80)}`,
      );
    if (listed.has(f["path"])) return fail("invalid", `The list holds ${f["path"]} twice.`);
    listed.set(f["path"], { path: f["path"], sha256: f["sha256"], size: f["size"] });
  }
  for (const path of found.keys())
    if (path !== "manifest.json" && !listed.has(path))
      return fail(
        "invalid",
        `The bundle holds a file that is not on its list: ${path.slice(0, 80)}. Nothing was imported.`,
      );
  for (const f of listed.values()) {
    const data = found.get(f.path);
    if (!data)
      return fail(
        "invalid",
        `A file on the list is missing from the bundle: ${f.path.slice(0, 80)}. Nothing was imported.`,
      );
    if (data.length !== f.size || sha256(data) !== f.sha256)
      return fail(
        "invalid",
        `A file was changed after the bundle was made: ${f.path.slice(0, 80)}. Nothing was imported.`,
      );
  }
  for (const needed of ["content.json", "settings.json"])
    if (!listed.has(needed)) return fail("invalid", `The bundle has no ${needed}.`);

  let content: unknown;
  let settingsFile: unknown;
  try {
    content = JSON.parse(found.get("content.json")!.toString("utf8"));
    settingsFile = JSON.parse(found.get("settings.json")!.toString("utf8"));
  } catch {
    return fail("invalid", "The content of the bundle cannot be read.");
  }
  if (
    !isObject(content) ||
    !isObject(content["tables"]) ||
    !isObject(settingsFile) ||
    !isObject(settingsFile["settings"])
  )
    return fail("invalid", "The content of the bundle is not in the expected shape.");
  const given = content["tables"];
  const wanted = [...CONTENT_TABLES, "themes"] as string[];
  for (const name of Object.keys(given))
    if (!wanted.includes(name))
      return fail("invalid", `The bundle holds data this version does not know: ${name}`);
  const tables = {} as CheckedBundle["tables"];
  for (const name of wanted) {
    const rows = given[name] ?? [];
    if (!Array.isArray(rows)) return fail("invalid", `The ${name} of the bundle are damaged.`);
    const columns = columnsOf(name).sort().join(",");
    for (const r of rows)
      if (!isObject(r) || Object.keys(r).sort().join(",") !== columns)
        return fail("invalid", `The ${name} of the bundle do not have the expected columns.`);
    (tables as Record<string, Row[]>)[name] = rows as Row[];
  }
  const settings = settingsFile["settings"];
  for (const key of Object.keys(settings))
    if (!(BUNDLE_SETTINGS as readonly string[]).includes(key))
      return fail(
        "invalid",
        `The bundle holds a setting that is never imported: ${key.slice(0, 40)}`,
      );

  // Themes that come with a product only.
  if (tables.themes.some((t) => t["source"] !== "build"))
    return fail(
      "invalid",
      "The bundle holds an installed theme, which is not allowed in a bundle.",
    );

  // Every uploaded file belongs to a record, and every record has its file, checked again like a new upload.
  const media = new Map<string, Uint8Array>();
  const used = new Set<string>();
  const need = (key: unknown, label: string): string | BundleFail => {
    if (typeof key !== "string")
      return fail("invalid", `A ${label} of the bundle has no file name.`);
    try {
      assertSafeKey(key);
    } catch {
      return fail("invalid", `A ${label} of the bundle has a path that is not allowed.`);
    }
    if (!listed.has(`media/${key}`))
      return fail(
        "invalid",
        `The file of a ${label} is missing from the bundle: ${key.slice(0, 80)}`,
      );
    used.add(`media/${key}`);
    return key;
  };
  for (const m of tables.media) {
    const key = need(m["storage_key"], "media record");
    if (typeof key !== "string") return key;
    const bytes = found.get(`media/${key}`)!;
    const checked = checkUpload(String(m["filename"]), bytes, {
      canUploadSvg: true,
      maxBytes: FILE_MAX_BYTES,
    });
    if (!checked.ok)
      return fail(
        "invalid",
        `The file ${String(m["filename"]).slice(0, 80)} is refused: ${checked.reason}`,
      );
    let stored: Uint8Array = bytes;
    if (checked.type.kind === "svg") {
      try {
        stored = new TextEncoder().encode(await cleanSvg(bytes));
      } catch (error) {
        if (error instanceof SvgRefused)
          return fail(
            "invalid",
            `The picture ${String(m["filename"]).slice(0, 80)} is refused: ${error.message}`,
          );
        throw error;
      }
    }
    media.set(key, stored);
  }
  for (const v of tables.media_variants) {
    const key = need(v["storage_key"], "size of a picture");
    if (typeof key !== "string") return key;
    const bytes = found.get(`media/${key}`)!;
    const checked = checkUpload(key.split("/").pop() ?? key, bytes, {
      canUploadSvg: false,
      maxBytes: FILE_MAX_BYTES,
    });
    if (!checked.ok || checked.type.kind !== "image")
      return fail("invalid", `A size of a picture is refused: ${key.slice(0, 80)}`);
    media.set(key, bytes);
  }
  for (const path of listed.keys())
    if (path.startsWith("media/") && !used.has(path))
      return fail(
        "invalid",
        `The bundle holds a file that no record uses: ${path.slice(0, 80)}. Nothing was imported.`,
      );
    else if (!path.startsWith("media/") && path !== "content.json" && path !== "settings.json")
      return fail(
        "invalid",
        `The bundle holds a file it should not: ${path.slice(0, 80)}. Nothing was imported.`,
      );

  return {
    ok: true,
    bundle: { manifest: manifestValue as unknown as BundleManifest, tables, settings, media },
  };
}

// ----------------------------------------------------------------------------------------------------------------- import

export interface ImportedBundle {
  counts: BundleCounts;
  siteName: string;
  /** Names of themes in the bundle that this site does not have, so their look was not taken. */
  skippedThemes: string[];
  /** The addresses of the pages and posts before and after, to make the public pages fresh. */
  slugs: string[];
}

/**
 * Puts a bundle on this site, in place of its pages, posts, media, menus and the rest of what the bundle holds. The files
 * are stored first; the records are changed in one step, so a failure leaves the site as it was.
 */
export async function importBundle(
  runner: SqlRunner,
  storage: StorageAdapter,
  actor: Actor,
  siteId: string,
  archive: Buffer,
  options: { replace: boolean; maxUnpackedBytes?: number; now?: () => number },
): Promise<({ ok: true } & ImportedBundle) | BundleFail> {
  if (!actor.can("import") || !actor.can("settings.manage"))
    return fail("forbidden", "You may not import a site.");
  if (!options.replace)
    return fail(
      "invalid",
      "Confirm first that this replaces the pages, posts, media, menus and look of this site.",
    );
  const checked = await checkBundle(archive, options.maxUnpackedBytes);
  if (!checked.ok) return checked;
  const { bundle } = checked;
  const now = options.now ?? Date.now;

  // Files first. A file this import wrote that was not there before is taken away again if the records fail.
  const written: string[] = [];
  try {
    for (const [key, bytes] of bundle.media) {
      if (!(await storage.exists(key))) written.push(key);
      await storage.put(key, bytes);
    }
  } catch {
    for (const key of written) await storage.delete(key).catch(() => undefined);
    return fail("invalid", "The files could not be stored. Nothing was changed.");
  }

  const skippedThemes: string[] = [];
  let oldKeys: string[] = [];
  let oldSlugs: string[] = [];
  try {
    await runner.transaction(async (tx) => {
      const own = `"site_id" = ?`;
      oldKeys = (
        await tx.all(
          `select "storage_key" from "media" where ${own} union select "storage_key" from "media_variants" where "media_id" in (select "id" from "media" where ${own})`,
          [siteId, siteId],
        )
      ).map((r) => String(r["storage_key"]));
      oldSlugs = (await tx.all(`select "slug" from "entries" where ${own}`, [siteId])).map((r) =>
        String(r["slug"]),
      );
      const ofSite = (table: string, column: string) =>
        `delete from "${table}" where "${column}" in (select "id" from "entries" where ${own})`;
      await tx.all(`delete from "comments" where ${own}`, [siteId]);
      for (const [table, column] of [
        ["entry_revisions", "entry_id"],
        ["entry_locks", "entry_id"],
        ["entry_terms", "entry_id"],
        ["entry_media", "entry_id"],
      ] as const)
        await tx.all(ofSite(table, column), [siteId]);
      await tx.all(`delete from "entries" where ${own}`, [siteId]);
      await tx.all(
        `delete from "terms" where "taxonomy_id" in (select "id" from "taxonomies" where ${own})`,
        [siteId],
      );
      await tx.all(`delete from "taxonomies" where ${own}`, [siteId]);
      await tx.all(`delete from "menus" where ${own}`, [siteId]);
      await tx.all(`delete from "redirects" where ${own}`, [siteId]);
      await tx.all(
        `delete from "entry_media" where "media_id" in (select "id" from "media" where ${own})`,
        [siteId],
      );
      await tx.all(
        `delete from "media_variants" where "media_id" in (select "id" from "media" where ${own})`,
        [siteId],
      );
      await tx.all(`delete from "media" where ${own}`, [siteId]);
      await tx.all(`delete from "media_folders" where ${own}`, [siteId]);
      await tx.all(
        `delete from "saved_section_versions" where "section_id" in (select "id" from "saved_sections" where ${own})`,
        [siteId],
      );
      await tx.all(`delete from "saved_sections" where ${own}`, [siteId]);
      await tx.all(
        `delete from "field_definitions" where "content_type_id" in (select "id" from "content_types" where ${own})`,
        [siteId],
      );
      await tx.all(`delete from "content_types" where ${own}`, [siteId]);

      const mine = (rows: Row[], table: ContentTable): Row[] =>
        rows.map((r) => {
          const out: Row = { ...r };
          if ("site_id" in out) out["site_id"] = siteId;
          for (const c of PERSON[table] ?? []) out[c] = actor.userId;
          return out;
        });
      for (const table of CONTENT_TABLES) {
        if (table === "theme_overrides") continue;
        await writeRows(tx, table, mine(bundle.tables[table], table));
      }

      // The look: only for a theme this site has, by its key. The layouts of such a theme are replaced.
      const have = await tx.all(
        `select "id", "key" from "themes" where ${own} and "source" = 'build'`,
        [siteId],
      );
      const idByKey = new Map(have.map((t) => [String(t["key"]), String(t["id"])]));
      const mapped = new Map<string, string>();
      for (const t of bundle.tables.themes) {
        const id = idByKey.get(String(t["key"]));
        if (!id) {
          skippedThemes.push(String(t["key"]));
          continue;
        }
        mapped.set(String(t["id"]), id);
        await tx.all(`update "themes" set "settings" = ? where "id" = ?`, [
          JSON.stringify(t["settings"]),
          id,
        ]);
        await tx.all(`delete from "theme_overrides" where "theme_id" = ?`, [id]);
      }
      const active = bundle.tables.themes.find(
        (t) => t["is_active"] === true && mapped.has(String(t["id"])),
      );
      if (active) {
        await tx.all(`update "themes" set "is_active" = ? where ${own} and "source" = 'build'`, [
          false,
          siteId,
        ]);
        await tx.all(`update "themes" set "is_active" = ? where "id" = ?`, [
          true,
          mapped.get(String(active["id"])),
        ]);
      }
      await writeRows(
        tx,
        "theme_overrides",
        bundle.tables.theme_overrides
          .filter((o) => mapped.has(String(o["theme_id"])))
          .map((o) => ({ ...o, theme_id: mapped.get(String(o["theme_id"])) })),
      );

      for (const [key, value] of Object.entries(bundle.settings)) {
        await tx.all(`delete from "settings" where ${own} and "key" = ?`, [siteId, key]);
        await tx.all(
          `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)`,
          [siteId, key, JSON.stringify(value), new Date(now())],
        );
      }
      await tx.all(
        `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id",
          "detail", "created_at") values (?, ?, 'user', ?, 'site.bundle_import', 'site', ?, ?, ?)`,
        [
          newId(),
          siteId,
          actor.userId,
          siteId,
          JSON.stringify({
            entries: bundle.tables.entries.length,
            media: bundle.tables.media.length,
            from: bundle.manifest.siteName,
          }),
          new Date(now()),
        ],
      );
    });
  } catch {
    for (const key of written) await storage.delete(key).catch(() => undefined);
    return fail("invalid", "The bundle could not be imported, and nothing was changed.");
  }

  // The files of the old site that the new one does not use.
  const kept = new Set(bundle.media.keys());
  for (const key of oldKeys) if (!kept.has(key)) await storage.delete(key).catch(() => undefined);

  return {
    ok: true,
    counts: {
      entries: bundle.tables.entries.length,
      media: bundle.tables.media.length,
      menus: bundle.tables.menus.length,
      settings: Object.keys(bundle.settings).length,
    },
    siteName: bundle.manifest.siteName,
    skippedThemes,
    slugs: [...new Set([...oldSlugs, ...bundle.tables.entries.map((e) => String(e["slug"]))])],
  };
}
