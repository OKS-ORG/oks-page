// Tools > Privacy requests (spec 18, section 5; spec 16, FM-08): enter an email address and the site finds everything it keeps
// that is linked to it, gives it as a ZIP of readable files, or deletes it. What a plugin keeps is found through what the
// plugin declared (`personalData` in its manifest: a collection of its own storage and the fields that hold an email
// address), so no plugin code runs. The files kept with an item are found, exported and deleted with it. The site's own
// records of emails it sent to the address are included. An account is only reported (it is managed in Users). Every request is written to
// the audit log, with a hash of the address and counts, never the data.
import { zipOf, type Actor } from "@oks-page/core";
import { newId, type SqlRunner } from "@oks-page/db";
import { collectionOf, readPersonalData, type PersonalDataSource } from "@oks-page/sandbox";
import { createHash } from "node:crypto";
import { fieldOf, show } from "./plugin-pages";

export type PrivacyResult<T> =
  ({ ok: true } & T) | { ok: false; code: "forbidden" | "invalid"; message: string };

const fail = (code: "forbidden" | "invalid", message: string) =>
  ({ ok: false, code, message }) as const;

/** The most items one kind of data lists on the screen (the count says how many there are). */
const LIST_MOST = 200;
/** The most items of one kind one request handles; a person with more is handled in rounds. */
const HANDLE_MOST = 5000;
/** How many stored items are looked through for one kind of data. */
const SCAN_MOST = 50_000;
const BATCH = 200;
/** An export bigger than this is refused (the files are the weight). */
const EXPORT_BYTES_MOST = 100 * 1024 * 1024;

/** The address in its one plain form (no capitals, no surrounding spaces), or null when it is not an address. */
export function normalizeEmail(value: unknown): string | null {
  const e = typeof value === "string" ? value.trim().toLowerCase() : "";
  return e.length >= 3 && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** What the audit log keeps of an address: a hash, so a request is recorded and nobody can read who it was about. */
export const emailHash = (email: string): string =>
  createHash("sha256").update(email).digest("hex");

export interface FoundFile {
  id: string;
  name: string;
  size: number;
}

export interface FoundItem {
  /** The item's key in the plugin's storage, or the id of the record. */
  key: string;
  cells: { label: string; text: string }[];
  files: FoundFile[];
}

export interface FoundGroup {
  kind: "plugin" | "email_log" | "account";
  plugin?: string;
  /** The id of what the plugin declared (a plugin has several kinds). */
  sourceId: string;
  label: string;
  /** How many items there are (the list shows the first ones). */
  total: number;
  items: FoundItem[];
  /** False for an account: it is only reported. */
  deletable: boolean;
  note?: string;
}

export interface PrivacyFindResult {
  email: string;
  groups: FoundGroup[];
  /** How many items a deletion would remove (accounts are not counted). */
  deletable: number;
}

interface Stored {
  key: string;
  value: unknown;
  updatedAt: number;
}

interface Source {
  extensionId: string;
  plugin: string;
  def: PersonalDataSource;
  collection: string;
}

const parse = (value: unknown): Record<string, unknown> => {
  try {
    const v = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Everything the plugins of the site declared, including plugins that are switched off (their data is still there). */
async function sourcesOf(runner: SqlRunner, siteId: string): Promise<Source[]> {
  const rows = await runner.all(
    `select "id", "key", "manifest" from "extensions" where "site_id" = ? and "kind" = 'plugin' order by "key"`,
    [siteId],
  );
  const out: Source[] = [];
  for (const r of rows) {
    const declared = readPersonalData(parse(r["manifest"])["personalData"] ?? []);
    if (typeof declared === "string") continue;
    for (const def of declared) {
      const collection = collectionOf(def.source);
      if (collection)
        out.push({ extensionId: String(r["id"]), plugin: String(r["key"]), def, collection });
    }
  }
  return out;
}

/** True when one of the fields holds the address, as a text or inside a list of texts. */
function holds(item: Stored, fields: string[], email: string): boolean {
  for (const f of fields) {
    const v = fieldOf(item, f);
    const all = Array.isArray(v) ? v : [v];
    if (all.some((x) => typeof x === "string" && x.trim().toLowerCase() === email)) return true;
  }
  return false;
}

/** The items of one plugin collection that belong to the address, at most `most`; `more` says there are others. */
async function matches(
  runner: SqlRunner,
  s: Source,
  email: string,
  most: number,
): Promise<{ items: Stored[]; more: boolean }> {
  const items: Stored[] = [];
  let cursor: string | null = null;
  let scanned = 0;
  for (;;) {
    const rows = await runner.all(
      `select "key", "value", "updated_at" from "extension_storage" where "extension_id" = ? and "collection" = ?${
        cursor === null ? "" : ' and "key" > ?'
      } order by "key" limit ${BATCH}`,
      cursor === null ? [s.extensionId, s.collection] : [s.extensionId, s.collection, cursor],
    );
    for (const r of rows) {
      scanned += 1;
      cursor = String(r["key"]);
      let value: unknown = r["value"];
      if (typeof value === "string" && runner.dialect === "sqlite") {
        try {
          value = JSON.parse(value);
        } catch {
          value = null;
        }
      }
      const item: Stored = {
        key: cursor,
        value,
        updatedAt: new Date(r["updated_at"] as string | number | Date).getTime(),
      };
      if (!holds(item, s.def.match, email)) continue;
      if (items.length >= most) return { items, more: true };
      items.push(item);
    }
    if (rows.length < BATCH || scanned >= SCAN_MOST) return { items, more: false };
  }
}

async function filesOf(runner: SqlRunner, s: Source, key: string): Promise<FoundFile[]> {
  const rows = await runner.all(
    `select "id", "name", "size_bytes" from "extension_files" where "extension_id" = ? and "collection" = ? and "key" = ? and "status" = 'kept' order by "id"`,
    [s.extensionId, s.collection, key],
  );
  return rows.map((r) => ({
    id: String(r["id"]),
    name: String(r["name"]),
    size: Number(r["size_bytes"]),
  }));
}

const cellsOf = (s: Source, item: Stored) =>
  s.def.show.map((c) => ({
    label: c.label,
    text: show(fieldOf(item, c.field), c.format ?? "text").slice(0, 300),
  }));

const note = (
  runner: SqlRunner,
  siteId: string,
  actor: Actor,
  action: string,
  email: string,
  detail: Record<string, unknown>,
) =>
  runner.all(
    `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id", "detail", "created_at") values (?, ?, 'user', ?, ?, 'privacy', ?, ?, ?)`,
    [newId(), siteId, actor.userId, action, emailHash(email), JSON.stringify(detail), new Date()],
  );

const ALLOWED = (actor: Actor) => actor.can("settings.manage");

/** The email-log lines for the address (the site's own record of emails it sent there). */
async function emailLog(runner: SqlRunner, siteId: string, email: string) {
  return runner.all(
    `select "id", "created_at", "subject", "status" from "email_log" where "site_id" = ? and lower("to_address") = ? order by "created_at" desc, "id"`,
    [siteId, email],
  );
}

const when = (v: unknown) =>
  new Date(v as string | number | Date).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** Finds everything the site keeps that is linked to the address. Nothing is changed. */
export async function findPersonalData(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  emailText: string,
): Promise<PrivacyResult<{ result: PrivacyFindResult }>> {
  if (!ALLOWED(actor)) return fail("forbidden", "You may not handle privacy requests.");
  const email = normalizeEmail(emailText);
  if (!email) return fail("invalid", "Enter a valid email address.");
  const groups: FoundGroup[] = [];
  let deletable = 0;

  const account = (
    await runner.all(
      `select u."id", u."name", u."created_at" from "users" u join "site_members" m on m."user_id" = u."id" where m."site_id" = ? and lower(u."email") = ?`,
      [siteId, email],
    )
  )[0];
  if (account)
    groups.push({
      kind: "account",
      sourceId: "account",
      label: "User account",
      total: 1,
      deletable: false,
      note: "This person has an account on the site. Change or remove it in Users; it is not removed here.",
      items: [
        {
          key: String(account["id"]),
          cells: [
            { label: "Name", text: String(account["name"]) },
            { label: "Created", text: when(account["created_at"]) },
          ],
          files: [],
        },
      ],
    });

  for (const s of await sourcesOf(runner, siteId)) {
    const found = await matches(runner, s, email, HANDLE_MOST);
    if (found.items.length === 0) continue;
    const items: FoundItem[] = [];
    for (const item of found.items.slice(0, LIST_MOST))
      items.push({
        key: item.key,
        cells: cellsOf(s, item),
        files: await filesOf(runner, s, item.key),
      });
    groups.push({
      kind: "plugin",
      plugin: s.plugin,
      sourceId: s.def.id,
      label: `${s.def.label} (${s.plugin})`,
      total: found.items.length,
      items,
      deletable: true,
      ...(found.more
        ? { note: `There are more than ${HANDLE_MOST}: delete these, then look again.` }
        : {}),
    });
    deletable += found.items.length;
  }

  const log = await emailLog(runner, siteId, email);
  if (log.length > 0) {
    groups.push({
      kind: "email_log",
      sourceId: "email-log",
      label: "Emails the site sent to this address",
      total: log.length,
      deletable: true,
      items: log.slice(0, LIST_MOST).map((r) => ({
        key: String(r["id"]),
        cells: [
          { label: "Sent", text: when(r["created_at"]) },
          { label: "Subject", text: String(r["subject"]).slice(0, 200) },
          { label: "Status", text: String(r["status"]) },
        ],
        files: [],
      })),
    });
    deletable += log.length;
  }
  await note(runner, siteId, actor, "privacy.find", email, {
    kinds: groups.map((g) => g.sourceId),
    items: deletable,
  });
  return { ok: true, result: { email, groups, deletable } };
}

const clean = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "file";

/** The ZIP of everything found for the address: readable JSON files, and the files kept with the items. */
export async function exportPersonalData(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  emailText: string,
): Promise<PrivacyResult<{ zip: Buffer; filename: string; items: number; files: number }>> {
  if (!ALLOWED(actor)) return fail("forbidden", "You may not handle privacy requests.");
  const email = normalizeEmail(emailText);
  if (!email) return fail("invalid", "Enter a valid email address.");
  const entries: { path: string; data: Buffer }[] = [];
  const json = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`, "utf8");
  let items = 0;
  let fileCount = 0;
  let bytes = 0;

  const account = (
    await runner.all(
      `select u."id", u."name", u."email", u."created_at" from "users" u join "site_members" m on m."user_id" = u."id" where m."site_id" = ? and lower(u."email") = ?`,
      [siteId, email],
    )
  )[0];
  if (account)
    entries.push({
      path: "account.json",
      data: json({
        id: account["id"],
        name: account["name"],
        email: account["email"],
        created: when(account["created_at"]),
      }),
    });

  for (const s of await sourcesOf(runner, siteId)) {
    const found = await matches(runner, s, email, HANDLE_MOST);
    if (found.items.length === 0) continue;
    const out: unknown[] = [];
    for (const item of found.items) {
      const files = await filesOf(runner, s, item.key);
      const names: string[] = [];
      for (const f of files) {
        const row = (
          await runner.all(
            `select "data" from "extension_files" where "id" = ? and "extension_id" = ?`,
            [f.id, s.extensionId],
          )
        )[0];
        if (!row) continue;
        const data = Buffer.from(row["data"] as Uint8Array);
        bytes += data.length;
        if (bytes > EXPORT_BYTES_MOST)
          return fail(
            "invalid",
            "There is too much to export in one go (over 100 MB of files). Delete or download part of it first.",
          );
        const path = `plugins/${s.plugin}/files/${f.id}-${clean(f.name)}`;
        entries.push({ path, data });
        names.push(path);
        fileCount += 1;
      }
      out.push({
        key: item.key,
        saved: new Date(item.updatedAt).toISOString(),
        data: item.value,
        files: names,
      });
      items += 1;
    }
    entries.push({ path: `plugins/${s.plugin}/${s.def.id}.json`, data: json(out) });
  }

  const log = await emailLog(runner, siteId, email);
  if (log.length > 0) {
    entries.push({
      path: "email-log.json",
      data: json(
        log.map((r) => ({
          sent: when(r["created_at"]),
          subject: r["subject"],
          status: r["status"],
        })),
      ),
    });
    items += log.length;
  }

  const name = (await runner.all(`select "name" from "sites" where "id" = ?`, [siteId]))[0]?.[
    "name"
  ];
  entries.push({
    path: "README.txt",
    data: Buffer.from(
      [
        `Personal data kept by ${String(name ?? "this site")} for ${email}`,
        `Made on ${new Date().toISOString()}.`,
        "",
        "Each JSON file lists what was found, as it is kept. Files that were sent are in the files folder of the plugin that kept them.",
        account ? "account.json is the person's account on the site." : "",
        "email-log.json lists emails the site sent to this address (the text of the emails is not kept).",
      ]
        .filter((l, i) => l !== "" || i === 2)
        .join("\n") + "\n",
    ),
  });
  await note(runner, siteId, actor, "privacy.export", email, { items, files: fileCount });
  return {
    ok: true,
    zip: zipOf(entries),
    filename: `personal-data-${emailHash(email).slice(0, 10)}.zip`,
    items,
    files: fileCount,
  };
}

/** Deletes what was found for the address: the plugins' items (with their files) and the site's email log lines. */
export async function deletePersonalData(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  emailText: string,
): Promise<PrivacyResult<{ items: number; files: number; emails: number; account: boolean }>> {
  if (!ALLOWED(actor)) return fail("forbidden", "You may not handle privacy requests.");
  const email = normalizeEmail(emailText);
  if (!email) return fail("invalid", "Enter a valid email address.");
  let items = 0;
  let files = 0;
  for (const s of await sourcesOf(runner, siteId)) {
    const found = await matches(runner, s, email, HANDLE_MOST);
    for (const item of found.items) {
      await runner.transaction(async (tx) => {
        const gone = await tx.all(
          `delete from "extension_files" where "extension_id" = ? and "collection" = ? and "key" = ? returning "id"`,
          [s.extensionId, s.collection, item.key],
        );
        files += gone.length;
        await tx.all(
          `delete from "extension_storage" where "extension_id" = ? and "collection" = ? and "key" = ?`,
          [s.extensionId, s.collection, item.key],
        );
      });
      items += 1;
    }
  }
  const log = await runner.all(
    `delete from "email_log" where "site_id" = ? and lower("to_address") = ? returning "id"`,
    [siteId, email],
  );
  const emails = log.length;
  const account =
    (
      await runner.all(
        `select 1 as x from "users" u join "site_members" m on m."user_id" = u."id" where m."site_id" = ? and lower(u."email") = ?`,
        [siteId, email],
      )
    ).length > 0;
  await note(runner, siteId, actor, "privacy.delete", email, {
    items,
    files,
    emails,
    accountLeft: account,
  });
  return { ok: true, items, files, emails, account };
}
