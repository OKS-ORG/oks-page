// Settings > Privacy (design batch 5; spec 18). A new site sets no cookies for visitors and loads nothing from other
// companies, so it needs no consent notice (PR-01, ADR 0016). The page lists every cookie the site sets (today only the
// sign-in cookie, which is only for people who sign in), says whether a consent notice is needed, and keeps which page
// is the privacy page. "Write a draft for me" makes a draft privacy page from what the site really uses (spec 18,
// section 4); the owner reads it, changes it and publishes it.
import type { SqlRunner } from "@oks-page/db";
import { createDraft, saveContent, type Actor } from "./content.js";

export const PRIVACY_SETTINGS_KEY = "privacy";

export interface SiteCookie {
  name: string;
  /** In plain words. */
  purpose: string;
  /** Who gets it. */
  who: "visitors" | "people who sign in";
  /** True: needed for the site to work, so no consent is asked. */
  needed: boolean;
}

/** Every cookie the site sets. Plugins will add theirs here when they declare them (spec 18, section 2). */
export const SITE_COOKIES: SiteCookie[] = [
  {
    name: "Sign-in cookie",
    purpose:
      "Keeps you signed in to the admin. It is needed for signing in, so no consent is asked.",
    who: "people who sign in",
    needed: true,
  },
];

/** Whether a consent notice is needed: only when something sets a cookie that needs consent, or loads outside content. */
export function consentNeeded(cookies: SiteCookie[] = SITE_COOKIES): boolean {
  return cookies.some((c) => !c.needed);
}

/** True when visitors (people who do not sign in) get no cookie at all. */
export function noVisitorCookies(cookies: SiteCookie[] = SITE_COOKIES): boolean {
  return cookies.every((c) => c.who !== "visitors");
}

export interface PrivacySettings {
  /** The privacy page, or null. */
  pageId: string | null;
}

const decode = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export async function loadPrivacySettings(
  runner: SqlRunner,
  siteId: string,
): Promise<PrivacySettings> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, PRIVACY_SETTINGS_KEY],
  );
  const v = decode(runner, rows[0]?.["value"]) as { pageId?: unknown } | null;
  const pageId =
    typeof v?.pageId === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v.pageId) ? v.pageId : null;
  return { pageId };
}

/** The pages that can be the privacy page: every page that is not in the trash, by title, with its status. */
export async function listPrivacyPageChoices(
  runner: SqlRunner,
  siteId: string,
): Promise<{ id: string; title: string; status: string }[]> {
  const rows = await runner.all(
    `select "id", "title", "status" from "entries" where "site_id" = ? and "type_key" = 'page'
      and "status" <> 'trash' and "locale" = '' order by "title"`,
    [siteId],
  );
  return rows.map((r) => ({
    id: String(r["id"]),
    title: String(r["title"]),
    status: String(r["status"]),
  }));
}

type Fail = { ok: false; code: "forbidden" | "invalid"; message: string; field?: string };

async function writeSettings(runner: SqlRunner, siteId: string, value: PrivacySettings) {
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, PRIVACY_SETTINGS_KEY, JSON.stringify(value), new Date()],
  );
}

/** Chooses the privacy page (null for none). Only people who manage the settings. */
export async function savePrivacyPage(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  pageId: unknown,
): Promise<{ ok: true; settings: PrivacySettings } | Fail> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  if (pageId === null || pageId === "") {
    await writeSettings(runner, siteId, { pageId: null });
    return { ok: true, settings: { pageId: null } };
  }
  if (
    typeof pageId !== "string" ||
    !(await listPrivacyPageChoices(runner, siteId)).some((p) => p.id === pageId)
  )
    return { ok: false, code: "invalid", message: "Choose one of your pages.", field: "pageId" };
  await writeSettings(runner, siteId, { pageId });
  return { ok: true, settings: { pageId } };
}

const text = (t: string) => ({ type: "text", text: t });
const paragraph = (id: string, t: string) => ({
  id,
  type: "paragraph",
  props: {},
  content: [text(t)],
  children: [],
});
const heading = (id: string, t: string) => ({
  id,
  type: "heading",
  props: { level: 2 },
  content: [text(t)],
  children: [],
});

/** What the site really uses, for the draft. */
export interface PrivacyFacts {
  siteName: string;
  /** The email provider's name when email is set up ("Brevo", "Other"), or null. */
  emailProvider: string | null;
}

/** The blocks of a draft privacy page, from what the site really uses (spec 18, section 4). */
export function privacyDraftBlocks(facts: PrivacyFacts): unknown[] {
  const blocks: unknown[] = [
    paragraph(
      "intro",
      `This page says what personal data ${facts.siteName} collects, why, and what you can do about it. It is a draft written by the site from what it really uses: check it, and add who runs the site and how to reach them.`,
    ),
    heading("cookies-h", "Cookies"),
    paragraph(
      "cookies",
      "Visitors get no cookies. People who sign in to work on the site get one cookie that keeps them signed in; it is needed for signing in.",
    ),
    heading("outside-h", "Content from other companies"),
    paragraph(
      "outside",
      "The site loads nothing from other companies, so no other company learns about your visit.",
    ),
    heading("stats-h", "Visitor statistics"),
    paragraph("stats", "The site does not count or follow visitors."),
  ];
  if (facts.emailProvider)
    blocks.push(
      heading("email-h", "Emails"),
      paragraph(
        "email",
        `When the site sends you an email (an invitation or a new password), it goes out through the email service ${facts.emailProvider}, which sees your address and the email.`,
      ),
    );
  blocks.push(
    heading("rights-h", "Your rights"),
    paragraph(
      "rights",
      "You may ask what personal data the site keeps about you, and ask for it to be corrected or deleted. Write to the person who runs the site.",
    ),
  );
  return blocks;
}

/**
 * Makes a draft page "Privacy" from what the site really uses and makes it the privacy page. Only people who manage the
 * settings (and may add pages). Nothing is published: the owner checks it first.
 */
export async function writePrivacyDraft(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  facts: PrivacyFacts,
): Promise<{ ok: true; id: string; slug: string } | Fail> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  const made = await createDraft(runner, actor, siteId, { type: "page", title: "Privacy" });
  if (!made.ok)
    return {
      ok: false,
      code: made.code === "forbidden" ? "forbidden" : "invalid",
      message: made.message,
    };
  const saved = await saveContent(runner, actor, siteId, made.id, {
    title: "Privacy",
    slugPart: made.slug,
    status: "draft",
    blocks: privacyDraftBlocks(facts),
    revision: made.revision,
  });
  if (!saved.ok) return { ok: false, code: "invalid", message: saved.message };
  await writeSettings(runner, siteId, { pageId: made.id });
  return { ok: true, id: made.id, slug: made.slug };
}
