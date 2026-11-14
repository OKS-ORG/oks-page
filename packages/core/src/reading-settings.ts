// Settings > Reading and Settings > Languages (spec 07, section 5; design batch 5).
//   Reading: what the home page shows (a page you choose, or your latest posts), the page that lists your posts, how many
//   posts a list shows, and whether feeds carry the full text or a summary.
//   Languages: the language of the site's content and its writing direction, which public pages declare so browsers,
//   screen readers and search engines read the text right (spec 12). Several languages per site come later (M5).
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export const READING_SETTINGS_KEY = "reading";
export const LANGUAGE_SETTINGS_KEY = "site-language";
export const PER_PAGE_MAX = 50;

export interface ReadingSettings {
  /** "page": the home page is a page (the one chosen, or the page at "/home"); "posts": the newest posts. */
  homeShows: "page" | "posts";
  /** The page shown at "/" when it shows a page; null for the page whose address is "home". */
  homePageId: string | null;
  /** The page whose address lists the newest posts; null for none. */
  postsPageId: string | null;
  /** How many posts a list shows. */
  perPage: number;
  /** True: feeds carry the whole text of each post; false: a summary. */
  feedFullText: boolean;
}

export const DEFAULT_READING: ReadingSettings = {
  homeShows: "page",
  homePageId: null,
  postsPageId: null,
  perPage: 10,
  feedFullText: true,
};

const decode = (runner: SqlRunner | null, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner?.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** What a stored value means; anything odd falls back to the default. */
export function readReadingSettings(raw: unknown): ReadingSettings {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = (x: unknown) =>
    typeof x === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(x) ? x : null;
  const perPage = Number(v["perPage"]);
  return {
    homeShows: v["homeShows"] === "posts" ? "posts" : "page",
    homePageId: id(v["homePageId"]),
    postsPageId: id(v["postsPageId"]),
    perPage: Number.isInteger(perPage) && perPage >= 1 && perPage <= PER_PAGE_MAX ? perPage : 10,
    feedFullText: v["feedFullText"] !== false,
  };
}

async function readSetting(runner: SqlRunner, siteId: string, key: string): Promise<unknown> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, key],
  );
  return decode(runner, rows[0]?.["value"]);
}

async function writeSetting(runner: SqlRunner, siteId: string, key: string, value: unknown) {
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, key, JSON.stringify(value), new Date()],
  );
}

export async function loadReadingSettings(
  runner: SqlRunner,
  siteId: string,
): Promise<ReadingSettings> {
  return readReadingSettings(await readSetting(runner, siteId, READING_SETTINGS_KEY));
}

/** A published page that can be the home page or the posts page. */
export interface PageChoice {
  id: string;
  title: string;
  slug: string;
}

/** The published pages of the site, by title. */
export async function listPageChoices(runner: SqlRunner, siteId: string): Promise<PageChoice[]> {
  const rows = await runner.all(
    `select "id", "title", "slug" from "entries" where "site_id" = ? and "type_key" = 'page'
      and "status" = 'published' and "locale" = '' order by "title"`,
    [siteId],
  );
  return rows.map((r) => ({
    id: String(r["id"]),
    title: String(r["title"]),
    slug: String(r["slug"]),
  }));
}

/** The addresses the reading settings point at, for the public pages. */
export interface ReadingRoutes {
  homeShows: "page" | "posts";
  /** The address of the page shown at "/" ("home" by default). */
  homeSlug: string;
  /** The address of the posts page, or null. */
  postsSlug: string | null;
  postsTitle: string;
  perPage: number;
}

/** The reading settings with the addresses of the chosen pages (a page that is no longer published is left out). */
export async function loadReadingRoutes(runner: SqlRunner, siteId: string): Promise<ReadingRoutes> {
  const s = await loadReadingSettings(runner, siteId);
  const pages = await listPageChoices(runner, siteId);
  const home = s.homePageId ? pages.find((p) => p.id === s.homePageId) : undefined;
  const posts = s.postsPageId ? pages.find((p) => p.id === s.postsPageId) : undefined;
  return {
    homeShows: s.homeShows,
    homeSlug: home?.slug ?? "home",
    postsSlug: posts && posts.slug !== (home?.slug ?? "home") ? posts.slug : null,
    postsTitle: posts?.title ?? "",
    perPage: s.perPage,
  };
}

type Fail = { ok: false; code: "forbidden" | "invalid"; message: string; field?: string };

/** Saves the reading settings. Only people who manage the settings; the chosen pages must be published pages. */
export async function saveReadingSettings(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: Partial<Record<keyof ReadingSettings, unknown>>,
): Promise<{ ok: true; settings: ReadingSettings } | Fail> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  const current = await loadReadingSettings(runner, siteId);
  const pages = await listPageChoices(runner, siteId);
  const page = (value: unknown, field: string): string | null | Fail => {
    if (value === null || value === "") return null;
    if (typeof value === "string" && pages.some((p) => p.id === value)) return value;
    return { ok: false, code: "invalid", message: "Choose a published page.", field };
  };
  const next: ReadingSettings = { ...current };
  if (input.homeShows !== undefined) {
    if (input.homeShows !== "page" && input.homeShows !== "posts")
      return {
        ok: false,
        code: "invalid",
        message: "Choose what the home page shows.",
        field: "homeShows",
      };
    next.homeShows = input.homeShows;
  }
  if (input.homePageId !== undefined) {
    const v = page(input.homePageId, "homePageId");
    if (v && typeof v === "object") return v;
    next.homePageId = v;
  }
  if (input.postsPageId !== undefined) {
    const v = page(input.postsPageId, "postsPageId");
    if (v && typeof v === "object") return v;
    next.postsPageId = v;
  }
  if (input.perPage !== undefined) {
    const n = Number(input.perPage);
    if (!Number.isInteger(n) || n < 1 || n > PER_PAGE_MAX)
      return {
        ok: false,
        code: "invalid",
        message: `Choose 1 to ${PER_PAGE_MAX} posts per page.`,
        field: "perPage",
      };
    next.perPage = n;
  }
  if (input.feedFullText !== undefined) {
    if (typeof input.feedFullText !== "boolean")
      return {
        ok: false,
        code: "invalid",
        message: "Choose what feeds show.",
        field: "feedFullText",
      };
    next.feedFullText = input.feedFullText;
  }
  if (next.homeShows === "page" && next.postsPageId && next.postsPageId === next.homePageId)
    return {
      ok: false,
      code: "invalid",
      message: "The home page and the posts page must be different pages.",
      field: "postsPageId",
    };
  await writeSetting(runner, siteId, READING_SETTINGS_KEY, next);
  return { ok: true, settings: next };
}

// ----- the site language (spec 12)

export interface SiteLanguageChoice {
  /** The language tag ("en-GB", "ar"). */
  tag: string;
  /** In English. */
  name: string;
  /** In the language itself. */
  native: string;
  rtl: boolean;
}

/** The languages offered; any other valid tag can be kept too (the list is what the screen shows). */
export const SITE_LANGUAGES: SiteLanguageChoice[] = [
  { tag: "en", name: "English", native: "English", rtl: false },
  {
    tag: "en-GB",
    name: "English (United Kingdom)",
    native: "English (United Kingdom)",
    rtl: false,
  },
  { tag: "en-US", name: "English (United States)", native: "English (United States)", rtl: false },
  { tag: "en-IN", name: "English (India)", native: "English (India)", rtl: false },
  { tag: "hi", name: "Hindi", native: "हिन्दी", rtl: false },
  { tag: "bn", name: "Bengali", native: "বাংলা", rtl: false },
  { tag: "mr", name: "Marathi", native: "मराठी", rtl: false },
  { tag: "ta", name: "Tamil", native: "தமிழ்", rtl: false },
  { tag: "te", name: "Telugu", native: "తెలుగు", rtl: false },
  { tag: "gu", name: "Gujarati", native: "ગુજરાતી", rtl: false },
  { tag: "kn", name: "Kannada", native: "ಕನ್ನಡ", rtl: false },
  { tag: "ml", name: "Malayalam", native: "മലയാളം", rtl: false },
  { tag: "pa", name: "Punjabi", native: "ਪੰਜਾਬੀ", rtl: false },
  { tag: "ur", name: "Urdu", native: "اردو", rtl: true },
  { tag: "ar", name: "Arabic", native: "العربية", rtl: true },
  { tag: "he", name: "Hebrew", native: "עברית", rtl: true },
  { tag: "fa", name: "Persian", native: "فارسی", rtl: true },
  { tag: "de", name: "German", native: "Deutsch", rtl: false },
  { tag: "fr", name: "French", native: "Français", rtl: false },
  { tag: "es", name: "Spanish", native: "Español", rtl: false },
  { tag: "pt", name: "Portuguese", native: "Português", rtl: false },
  { tag: "pt-BR", name: "Portuguese (Brazil)", native: "Português (Brasil)", rtl: false },
  { tag: "it", name: "Italian", native: "Italiano", rtl: false },
  { tag: "nl", name: "Dutch", native: "Nederlands", rtl: false },
  { tag: "pl", name: "Polish", native: "Polski", rtl: false },
  { tag: "tr", name: "Turkish", native: "Türkçe", rtl: false },
  { tag: "ru", name: "Russian", native: "Русский", rtl: false },
  { tag: "uk", name: "Ukrainian", native: "Українська", rtl: false },
  { tag: "id", name: "Indonesian", native: "Bahasa Indonesia", rtl: false },
  { tag: "vi", name: "Vietnamese", native: "Tiếng Việt", rtl: false },
  { tag: "th", name: "Thai", native: "ไทย", rtl: false },
  { tag: "zh-CN", name: "Chinese (Simplified)", native: "简体中文", rtl: false },
  { tag: "ja", name: "Japanese", native: "日本語", rtl: false },
  { tag: "ko", name: "Korean", native: "한국어", rtl: false },
  { tag: "sw", name: "Swahili", native: "Kiswahili", rtl: false },
];

export interface SiteLanguage {
  tag: string;
  /** "auto" follows the language (right to left for Arabic, Hebrew, Persian and Urdu). */
  direction: "auto" | "ltr" | "rtl";
}

export const DEFAULT_SITE_LANGUAGE: SiteLanguage = { tag: "en", direction: "auto" };

const TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function readSiteLanguage(raw: unknown): SiteLanguage {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tag = typeof v["tag"] === "string" && TAG.test(v["tag"]) ? v["tag"] : "en";
  const direction = v["direction"] === "ltr" || v["direction"] === "rtl" ? v["direction"] : "auto";
  return { tag, direction };
}

/** "ltr" or "rtl": what the public pages declare. */
export function directionOf(language: SiteLanguage): "ltr" | "rtl" {
  if (language.direction !== "auto") return language.direction;
  const base = language.tag.split("-")[0]!;
  return SITE_LANGUAGES.find((l) => l.tag === language.tag || l.tag === base)?.rtl ? "rtl" : "ltr";
}

export async function loadSiteLanguage(runner: SqlRunner, siteId: string): Promise<SiteLanguage> {
  return readSiteLanguage(await readSetting(runner, siteId, LANGUAGE_SETTINGS_KEY));
}

/** Saves the site language. Only people who manage the settings; the tag must be a valid language tag. */
export async function saveSiteLanguage(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: { tag?: unknown; direction?: unknown },
): Promise<{ ok: true; language: SiteLanguage } | Fail> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  const current = await loadSiteLanguage(runner, siteId);
  const tag = input.tag === undefined ? current.tag : input.tag;
  if (typeof tag !== "string" || !TAG.test(tag))
    return { ok: false, code: "invalid", message: "Choose a language.", field: "tag" };
  const direction = input.direction === undefined ? current.direction : input.direction;
  if (direction !== "auto" && direction !== "ltr" && direction !== "rtl")
    return {
      ok: false,
      code: "invalid",
      message: "Choose a writing direction.",
      field: "direction",
    };
  const language: SiteLanguage = { tag, direction };
  await writeSetting(runner, siteId, LANGUAGE_SETTINGS_KEY, language);
  return { ok: true, language };
}
