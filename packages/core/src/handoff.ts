// The handoff checklist (spec 11, section 9): what a freelancer goes through before giving a site to a client. It is a screen,
// not code: each item has a plain explanation and a done mark that the freelancer sets. Some items also say, from what the
// site knows, whether it looks done; the mark stays the person's own. Giving a site to a client never needs a licence.
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export const HANDOFF_KEY = "handoff";

export interface HandoffItem {
  id: string;
  title: string;
  /** Why it matters, in plain words. */
  why: string;
  /** Where in the admin to do it, when there is a place. */
  href?: string;
}

export const HANDOFF_ITEMS: HandoffItem[] = [
  {
    id: "passwords",
    title: "Passwords are changed",
    why: "Change the password you used while building the site, and give the client their own account instead of yours.",
    href: "/admin/users",
  },
  {
    id: "two-factor",
    title: "Two-factor sign-in is on",
    why: "An administrator account with a password only is the easiest way into a site. Turn on two-factor for every administrator.",
    href: "/admin/account",
  },
  {
    id: "domain",
    title: "The domain and its settings are done",
    why: "The site's own address points to the site, the secure connection (https) works, and the main address is set.",
    href: "/admin/settings/general",
  },
  {
    id: "backups",
    title: "Backups are running, and a restore was tried",
    why: "A backup you have never restored is a hope, not a backup. Make one, restore it somewhere else, and check the site.",
  },
  {
    id: "privacy",
    title: "Privacy and statistics are set",
    why: "The privacy page is written and published, and the consent notice and the visitor counts are the way the client wants them.",
    href: "/admin/settings/privacy",
  },
  {
    id: "email",
    title: "Email works and the contact form goes to the right address",
    why: "Sign-in links, password resets and form messages all need email. Send a test, and fill in the form's address.",
    href: "/admin/settings/email",
  },
  {
    id: "hosting",
    title: "It is written down who pays for hosting",
    why: "Say who pays the hosting and the domain, and when they renew, so the site does not go away by surprise.",
  },
  {
    id: "licence",
    title: "It is written down where the licence key lives",
    why: "If the site uses a paid plugin or an agency licence, the client or you must know where the key is kept.",
  },
  {
    id: "guide",
    title: "The client has a short guide or video",
    why: "Show how to edit a page, add a post, upload a picture and ask for help. Ten minutes of showing saves many emails.",
  },
];

/** What the site knows that bears on an item, so the screen can say "this looks done" (the person still marks it). */
export interface HandoffHints {
  twoFactor: { on: number; total: number };
  emailWorks: boolean;
  privacyPage: boolean;
}

export interface HandoffView {
  items: (HandoffItem & { done: boolean; hint: string })[];
  done: number;
  total: number;
}

const decode = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const KNOWN = new Set(HANDOFF_ITEMS.map((i) => i.id));

/** What the site's own facts say about an item, in words ("" when they say nothing). */
export function hintOf(id: string, facts: HandoffHints): string {
  if (id === "two-factor") {
    const { on, total } = facts.twoFactor;
    if (total === 0) return "";
    if (total === 1)
      return on === 1
        ? "Looks done: the administrator uses two-factor."
        : "Not yet: the administrator does not use two-factor.";
    return on === total
      ? `Looks done: all ${total} administrators use two-factor.`
      : `Not yet: ${on} of ${total} administrators use two-factor.`;
  }
  if (id === "email")
    return facts.emailWorks ? "Looks done: email is set up." : "Not yet: email is not set up.";
  if (id === "privacy")
    return facts.privacyPage
      ? "Looks done: a privacy page is chosen."
      : "Not yet: no privacy page is chosen.";
  return "";
}

export async function loadHandoff(
  runner: SqlRunner,
  siteId: string,
  facts: HandoffHints,
): Promise<HandoffView> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, HANDOFF_KEY],
  );
  const stored = decode(runner, rows[0]?.["value"]) as { done?: unknown } | null;
  const marked = new Set(
    (Array.isArray(stored?.done) ? stored.done : []).filter(
      (x): x is string => typeof x === "string" && KNOWN.has(x),
    ),
  );
  const items = HANDOFF_ITEMS.map((i) => ({
    ...i,
    done: marked.has(i.id),
    hint: hintOf(i.id, facts),
  }));
  return { items, done: items.filter((i) => i.done).length, total: items.length };
}

type Fail = { ok: false; code: "forbidden" | "invalid"; message: string };

/** Saves which items are marked done. Only people who manage the settings; an item that is not on the list is refused. */
export async function saveHandoff(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: unknown,
): Promise<{ ok: true; done: string[] } | Fail> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  const done = (input as { done?: unknown } | null)?.done;
  if (!Array.isArray(done) || done.length > HANDOFF_ITEMS.length)
    return { ok: false, code: "invalid", message: "The request was not understood." };
  if (done.some((x) => typeof x !== "string" || !KNOWN.has(x)))
    return { ok: false, code: "invalid", message: "This is not an item of the checklist." };
  const unique = HANDOFF_ITEMS.map((i) => i.id).filter((id) => done.includes(id));
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, HANDOFF_KEY, JSON.stringify({ done: unique }), new Date()],
  );
  return { ok: true, done: unique };
}
