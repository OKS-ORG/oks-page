// The site's navigation menus (spec 01, `menus`). A menu is a tree of items kept as JSON in the `menus` table. Two
// places exist until themes bring their own: the header menu ("primary") and the footer menu ("footer"). An item points
// at a page or post, at a category or tag, or at an address. Pages and terms are looked up when the menu is shown, so
// changing a page's address does not break the menu.
import { newId, type SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export const MENU_PLACES = [
  { key: "primary", label: "Header menu" },
  { key: "footer", label: "Footer menu" },
] as const;

export type MenuPlace = (typeof MENU_PLACES)[number]["key"];

export interface MenuItem {
  /** Kept as the person moves it around; unique inside one menu. */
  id: string;
  label: string;
  kind: "entry" | "term" | "url";
  /** For kind "entry": the page or post. */
  entryId?: string;
  /** For kind "term": the category or tag. */
  termId?: string;
  /** For kind "url": an address on this site ("/contact") or a full one ("https://example.com"). */
  url?: string;
  children: MenuItem[];
}

export interface MenuView {
  place: string;
  label: string;
  items: MenuItem[];
  /** Milliseconds; 0 when the menu was never saved. The save must send it back (the version check). */
  updatedAt: number;
}

export type MenuResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: "forbidden" | "invalid" | "conflict" | "not_found"; message: string };

const fail = (code: "forbidden" | "invalid" | "conflict" | "not_found", message: string) =>
  ({ ok: false, code, message }) as const;

export const MENU_LIMITS = { depth: 3, items: 100, label: 80, url: 500 } as const;

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const ADDRESS = /^(\/(?!\/)[^\s]*|https?:\/\/[^\s]+|mailto:[^\s]+|tel:[+0-9 ()-]+)$/i;

const time = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));

const parseItems = (raw: unknown): MenuItem[] => {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? (value as MenuItem[]) : [];
};

const placeLabel = (key: string) => MENU_PLACES.find((p) => p.key === key)?.label ?? key;

/** A menu as saved, or an empty one that was never saved. */
export async function loadMenu(
  runner: SqlRunner,
  siteId: string,
  place: string,
): Promise<MenuView> {
  const rows = await runner.all(
    `select "items", "updated_at" from "menus" where "site_id" = ? and "key" = ?`,
    [siteId, place],
  );
  const row = rows[0];
  return {
    place,
    label: placeLabel(place),
    items: row ? parseItems(row["items"]) : [],
    updatedAt: row ? time(row["updated_at"]) : 0,
  };
}

/** Checks the whole tree and returns it cleaned, or the reason in words. */
async function checkItems(
  runner: SqlRunner,
  siteId: string,
  items: unknown,
): Promise<MenuResult<{ items: MenuItem[] }>> {
  if (!Array.isArray(items)) return fail("invalid", "The menu was not understood.");
  const seen = new Set<string>();
  let count = 0;
  const walk = async (list: unknown[], depth: number): Promise<MenuItem[] | string> => {
    if (list.length > 0 && depth > MENU_LIMITS.depth)
      return `A menu may go at most ${MENU_LIMITS.depth} levels deep.`;
    const out: MenuItem[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") return "The menu was not understood.";
      const r = raw as Record<string, unknown>;
      if (++count > MENU_LIMITS.items) return `A menu may have at most ${MENU_LIMITS.items} items.`;
      const id = typeof r["id"] === "string" ? r["id"] : "";
      if (!ID.test(id) || seen.has(id)) return "The menu was not understood.";
      seen.add(id);
      const label = typeof r["label"] === "string" ? r["label"].trim() : "";
      if (!label) return "Every item needs a label.";
      if (label.length > MENU_LIMITS.label)
        return `A label may have at most ${MENU_LIMITS.label} characters.`;
      const children = r["children"] === undefined ? [] : r["children"];
      if (!Array.isArray(children)) return "The menu was not understood.";
      const item: MenuItem = { id, label, kind: "url", children: [] };
      if (r["kind"] === "entry") {
        const entryId = typeof r["entryId"] === "string" ? r["entryId"] : "";
        const found = entryId
          ? await runner.all(
              `select 1 as found from "entries" where "id" = ? and "site_id" = ? and "status" <> 'trash'`,
              [entryId, siteId],
            )
          : [];
        if (found.length === 0) return `“${label}” points to a page that does not exist.`;
        item.kind = "entry";
        item.entryId = entryId;
      } else if (r["kind"] === "term") {
        const termId = typeof r["termId"] === "string" ? r["termId"] : "";
        const found = termId
          ? await runner.all(
              `select 1 as found from "terms" t join "taxonomies" x on x."id" = t."taxonomy_id"
                where t."id" = ? and x."site_id" = ?`,
              [termId, siteId],
            )
          : [];
        if (found.length === 0)
          return `“${label}” points to a category or tag that does not exist.`;
        item.kind = "term";
        item.termId = termId;
      } else if (r["kind"] === "url") {
        const url = typeof r["url"] === "string" ? r["url"].trim() : "";
        if (!ADDRESS.test(url) || url.length > MENU_LIMITS.url)
          return `“${label}” needs an address that starts with /, https://, http://, mailto: or tel:.`;
        item.url = url;
      } else return "The menu was not understood.";
      const below = await walk(children, depth + 1);
      if (typeof below === "string") return below;
      item.children = below;
      out.push(item);
    }
    return out;
  };
  const cleaned = await walk(items, 1);
  return typeof cleaned === "string" ? fail("invalid", cleaned) : { ok: true, items: cleaned };
}

/**
 * Saves a menu. The caller sends the `updatedAt` it loaded: if someone saved in between, nothing is written and the
 * answer is "conflict", so one person never overwrites another's work without knowing.
 */
export async function saveMenu(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  place: string,
  input: { items: unknown; updatedAt: unknown },
): Promise<MenuResult<{ updatedAt: number; items: MenuItem[] }>> {
  if (!actor.can("menus.manage")) return fail("forbidden", "You may not change the menus.");
  if (!MENU_PLACES.some((p) => p.key === place)) return fail("not_found", "There is no such menu.");
  const expected = Number(input.updatedAt);
  if (!Number.isFinite(expected) || expected < 0)
    return fail("invalid", "The menu was not understood.");
  const checked = await checkItems(runner, siteId, input.items);
  if (!checked.ok) return checked;
  // The version always goes up, even when two saves fall in the same millisecond.
  const now = new Date(Math.max(Date.now(), expected + 1));
  const json = JSON.stringify(checked.items);
  const stale = fail(
    "conflict",
    "Someone saved this menu while you were editing. Reload it to see their changes.",
  );
  if (expected === 0) {
    const made = await runner.all(
      `insert into "menus" ("id", "site_id", "key", "label", "items", "updated_at") values (?, ?, ?, ?, ?, ?)
       on conflict ("site_id", "key") do nothing returning "id"`,
      [newId(), siteId, place, placeLabel(place), json, now],
    );
    if (made.length === 0) return stale;
  } else {
    const changed = await runner.all(
      `update "menus" set "items" = ?, "updated_at" = ? where "site_id" = ? and "key" = ? and "updated_at" = ? returning "id"`,
      [json, now, siteId, place, new Date(expected)],
    );
    if (changed.length === 0) return stale;
  }
  return { ok: true, updatedAt: now.getTime(), items: checked.items };
}

export interface MenuChoices {
  entries: { id: string; title: string; type: string; slug: string }[];
  terms: { id: string; name: string; kind: string; slug: string }[];
}

/** What can be put in a menu: published pages and posts (the newest 300) and every category and tag. */
export async function loadMenuChoices(runner: SqlRunner, siteId: string): Promise<MenuChoices> {
  const entries = await runner.all(
    `select "id", "title", "type_key", "slug" from "entries"
      where "site_id" = ? and "status" = 'published' and "locale" = ''
      order by "type_key", "title" limit 300`,
    [siteId],
  );
  const terms = await runner.all(
    `select t."id", t."name", t."slug", x."key" from "terms" t join "taxonomies" x on x."id" = t."taxonomy_id"
      where x."site_id" = ? and x."key" in ('category', 'tag') order by x."key", t."name"`,
    [siteId],
  );
  return {
    entries: entries.map((e) => ({
      id: String(e["id"]),
      title: String(e["title"]),
      type: String(e["type_key"]),
      slug: String(e["slug"]),
    })),
    terms: terms.map((t) => ({
      id: String(t["id"]),
      name: String(t["name"]),
      kind: String(t["key"]),
      slug: String(t["slug"]),
    })),
  };
}

/** An item as the public site draws it: a label, an address and the items under it. */
export interface PublicMenuItem {
  id: string;
  label: string;
  href: string;
  children: PublicMenuItem[];
}

/**
 * A saved menu as visitors see it. A page or post is looked up now, so a changed address is followed; one that is not
 * published (a draft, private, scheduled or trashed page) is left out together with the items under it. A category or
 * tag that was deleted is left out the same way.
 */
export async function loadPublicMenu(
  runner: SqlRunner,
  siteId: string,
  place: string,
): Promise<PublicMenuItem[]> {
  const items = (await loadMenu(runner, siteId, place)).items;
  const entryIds: string[] = [];
  const termIds: string[] = [];
  const collect = (list: MenuItem[]) => {
    for (const item of list) {
      if (item.kind === "entry" && item.entryId) entryIds.push(item.entryId);
      if (item.kind === "term" && item.termId) termIds.push(item.termId);
      collect(item.children ?? []);
    }
  };
  collect(items);
  const marks = (ids: string[]) => ids.map(() => "?").join(", ");
  const slugs = new Map<string, string>();
  if (entryIds.length > 0)
    for (const r of await runner.all(
      `select "id", "slug" from "entries" where "site_id" = ? and "status" = 'published' and "locale" = ''
         and "id" in (${marks(entryIds)})`,
      [siteId, ...entryIds],
    ))
      slugs.set(String(r["id"]), String(r["slug"]));
  const terms = new Map<string, string>();
  if (termIds.length > 0)
    for (const r of await runner.all(
      `select t."id", t."slug", x."key" from "terms" t join "taxonomies" x on x."id" = t."taxonomy_id"
        where x."site_id" = ? and t."id" in (${marks(termIds)})`,
      [siteId, ...termIds],
    ))
      terms.set(String(r["id"]), `/${String(r["key"])}/${String(r["slug"])}`);
  const hrefOf = (item: MenuItem): string | null => {
    if (item.kind === "entry") {
      const slug = slugs.get(item.entryId ?? "");
      return slug === undefined ? null : slug === "home" ? "/" : `/${slug}`;
    }
    if (item.kind === "term") return terms.get(item.termId ?? "") ?? null;
    return item.url ?? null;
  };
  const draw = (list: MenuItem[]): PublicMenuItem[] => {
    const out: PublicMenuItem[] = [];
    for (const item of list) {
      const href = hrefOf(item);
      if (href === null) continue;
      out.push({ id: item.id, label: item.label, href, children: draw(item.children ?? []) });
    }
    return out;
  };
  return draw(items);
}
