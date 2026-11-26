// Site health (spec 07, section 16; D125): one list of plain checks for the people who run the site. Each result is green (fine),
// amber (worth a look), red (needs action now) or grey ("could not check", which is not counted as a problem). The checks that need
// the server itself (the certificate, the disk, the sign-in secret) are measured by the host and passed in as facts; the checks that
// need the database are read here. Amber results can be hidden ("I know, hide this") and come back when they get worse or after
// 90 days; red results can never be hidden.
import type { SqlRunner } from "@oks-page/db";
import { dailyBackupOn, loadBackupState, RECENT_MS } from "./backup-schedule.js";
import type { Actor } from "./content.js";
import { emailHealth } from "./email-domain.js";
import { emailWorks } from "./email.js";
import { loadUpdateView, type InstalledItem } from "./updates.js";

export const HEALTH_HIDDEN_KEY = "health_hidden";
export const HEALTH_BEAT_KEY = "scheduler_heartbeat";
/** An amber result that was hidden comes back after this long even if it did not get worse. */
export const HIDE_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;

export type HealthLevel = "green" | "amber" | "red" | "grey";
export type HealthArea = "Security" | "Email" | "Updates" | "Running" | "Plugins" | "Backups";

export interface HealthResult {
  key: string;
  area: HealthArea;
  title: string;
  level: HealthLevel;
  /** One or two plain sentences on what it means and why it matters. */
  text: string;
  /** Where to fix it. */
  fix?: { label: string; href: string };
  /** How many things are wrong (people without two-factor, plugins switched off): a hidden result comes back when it grows. */
  count?: number;
}

export interface HiddenInfo {
  key: string;
  until: number;
  at: number;
  by: string;
}
export interface HealthReport {
  results: HealthResult[];
  /** Amber results the owner chose to hide, with who hid them and when. */
  hidden: (HealthResult & { hiddenBy: string; hiddenAt: number })[];
  summary: { red: number; amber: number; grey: number; green: number };
}

/** What the host measures about the server it runs on. Anything that cannot be known is null. */
export interface HealthFacts {
  core: string;
  installed: InstalledItem[];
  /** The plugins and their state (switched off ones are a problem). */
  plugins: { id: string; name: string; status: string }[];
  secret: { present: boolean; length: number; example: boolean };
  production: boolean;
  /** The site's public address, or null when it is not set. */
  publicUrl: string | null;
  /** The certificate of the public address: days left, or null when it could not be read. */
  certificateDaysLeft: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  admins: { name: string; twoFactor: boolean }[];
  /** The newest backup that passed its check. */
  lastGoodBackupAt: number | null;
}

// ---- the heartbeat of the scheduler ----

const parse = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
async function read(
  runner: SqlRunner,
  siteId: string,
  key: string,
): Promise<Record<string, unknown>> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, key],
  );
  const v = parse(runner, rows[0]?.["value"]);
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
async function write(
  runner: SqlRunner,
  siteId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, key, JSON.stringify(value), new Date()],
  );
}

/** The timer notes that it ran (at most once a minute, so it costs nothing). */
export async function recordHeartbeat(
  runner: SqlRunner,
  siteId: string,
  now: number = Date.now(),
): Promise<void> {
  const last = (await read(runner, siteId, HEALTH_BEAT_KEY))["at"];
  if (typeof last === "number" && now - last < 60_000) return;
  await write(runner, siteId, HEALTH_BEAT_KEY, { at: now });
}
export async function loadHeartbeat(runner: SqlRunner, siteId: string): Promise<number | null> {
  const at = (await read(runner, siteId, HEALTH_BEAT_KEY))["at"];
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

// ---- hiding ----

interface HiddenEntry {
  until: number;
  at: number;
  by: string;
  level: HealthLevel;
  count: number | null;
}
async function loadHidden(runner: SqlRunner, siteId: string): Promise<Record<string, HiddenEntry>> {
  const raw = await read(runner, siteId, HEALTH_HIDDEN_KEY);
  const out: Record<string, HiddenEntry> = {};
  for (const [key, v] of Object.entries(raw)) {
    const e = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    if (typeof e["until"] !== "number" || typeof e["at"] !== "number") continue;
    out[key] = {
      until: e["until"],
      at: e["at"],
      by: typeof e["by"] === "string" ? e["by"] : "",
      level: "amber",
      count: typeof e["count"] === "number" ? e["count"] : null,
    };
  }
  return out;
}

/** A hidden result is shown again when it is no longer amber, got worse (more things wrong), or the hiding ran out. */
function stillHidden(entry: HiddenEntry | undefined, result: HealthResult, now: number): boolean {
  if (!entry || result.level !== "amber") return false;
  if (now >= entry.until) return false;
  if (entry.count !== null && (result.count ?? 0) > entry.count) return false;
  return true;
}

// ---- the checks ----

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

function isPublicUrl(url: string | null): url is string {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return !(
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".localhost") ||
      host.endsWith(".test")
    );
  } catch {
    return false;
  }
}

/** Runs every check once. Needs nothing from outside the site except the facts the host passes in. */
export async function runHealthChecks(
  runner: SqlRunner,
  siteId: string,
  facts: HealthFacts,
  now: number = Date.now(),
  options: { keys?: readonly string[] } = {},
): Promise<HealthReport> {
  const r: HealthResult[] = [];
  const add = (x: HealthResult) => r.push(x);
  const publicSite = isPublicUrl(facts.publicUrl);

  // Updates: the list, the warnings and what is behind.
  const view = await loadUpdateView(
    runner,
    siteId,
    { core: facts.core, items: facts.installed },
    { now: () => now, ...(options.keys ? { keys: options.keys } : {}) },
  );
  const comparison = view.comparison;
  add(
    comparison && !comparison.core.supported
      ? {
          key: "support",
          area: "Security",
          title: "This version no longer gets security fixes",
          level: "red",
          text: "The newest versions the update list names are for a newer major version. Update, or problems found in this version will not be fixed.",
          fix: { label: "See the updates", href: "/admin/tools/updates" },
        }
      : {
          key: "support",
          area: "Security",
          title: "The version still gets security fixes",
          level: comparison ? "green" : "grey",
          text: comparison
            ? "The update list names this major version."
            : "There is no update list yet, so this cannot be checked.",
        },
  );
  const warned = comparison?.warnings ?? [];
  const unsafe = (comparison?.items ?? []).filter(
    (i) => i.unsafe && facts.plugins.some((p) => p.id === i.key && p.status === "enabled"),
  );
  add(
    warned.length > 0 || unsafe.length > 0
      ? {
          key: "warnings",
          area: "Security",
          title: "A security warning names this site",
          level: "red",
          text: `${[...warned.map((w) => w.summary), ...unsafe.map((i) => `${i.name} ${i.version} is marked unsafe.`)].slice(0, 3).join(" ")}`,
          fix: { label: "See the updates", href: "/admin/tools/updates" },
          count: warned.length + unsafe.length,
        }
      : {
          key: "warnings",
          area: "Security",
          title: "No security warning names this site",
          level: comparison ? "green" : "grey",
          text: comparison
            ? "None of the warnings in the update list names the core or a plugin this site runs."
            : "There is no update list yet, so this cannot be checked.",
        },
  );

  // HTTPS: the site's own public address; no outside service.
  if (!publicSite)
    add({
      key: "https",
      area: "Security",
      title: "HTTPS and the certificate",
      level: "grey",
      text: "The site's public address is not set, or it is a local one, so this cannot be checked.",
    });
  else if (!facts.publicUrl!.startsWith("https://"))
    add({
      key: "https",
      area: "Security",
      title: "The public address does not use HTTPS",
      level: "red",
      text: "Visitors and people who sign in are not protected. Serve the site over HTTPS.",
    });
  else if (facts.certificateDaysLeft === null)
    add({
      key: "https",
      area: "Security",
      title: "HTTPS and the certificate",
      level: "grey",
      text: "The certificate could not be read from this server.",
    });
  else if (facts.certificateDaysLeft <= 3)
    add({
      key: "https",
      area: "Security",
      title:
        facts.certificateDaysLeft < 0
          ? "The certificate has ended"
          : "The certificate ends very soon",
      level: "red",
      text: `The certificate ends in ${Math.max(facts.certificateDaysLeft, 0)} day(s). Renew it now.`,
    });
  else if (facts.certificateDaysLeft <= 14)
    add({
      key: "https",
      area: "Security",
      title: "The certificate ends soon",
      level: "amber",
      text: `The certificate ends in ${facts.certificateDaysLeft} days. Check that it renews by itself.`,
    });
  else
    add({
      key: "https",
      area: "Security",
      title: "HTTPS and the certificate are fine",
      level: "green",
      text: `The certificate is good for ${facts.certificateDaysLeft} more days.`,
    });

  const without = facts.admins.filter((a) => !a.twoFactor);
  add(
    without.length > 0
      ? {
          key: "two-factor",
          area: "Security",
          title: "Administrators without two-factor sign-in",
          level: "amber",
          text: `${without
            .map((a) => a.name)
            .slice(0, 5)
            .join(
              ", ",
            )} ${without.length === 1 ? "has" : "have"} no two-factor sign-in. An administrator account is the most valuable key to the site.`,
          fix: { label: "Your account", href: "/admin/account" },
          count: without.length,
        }
      : {
          key: "two-factor",
          area: "Security",
          title: "Every administrator uses two-factor sign-in",
          level: facts.admins.length > 0 ? "green" : "grey",
          text:
            facts.admins.length > 0
              ? "All administrators have it on."
              : "No administrator was found.",
        },
  );
  add(
    !facts.production && publicSite
      ? {
          key: "debug",
          area: "Security",
          title: "The site runs in development mode",
          level: "red",
          text: "Development mode is slow and shows more than it should. Build the site and start it in production mode.",
        }
      : {
          key: "debug",
          area: "Security",
          title: "Development mode is off",
          level: "green",
          text: "The site runs in production mode, or is not on a public address.",
        },
  );
  add(
    !facts.secret.present || facts.secret.length < 32 || facts.secret.example
      ? {
          key: "secret",
          area: "Security",
          title: "The sign-in secret is weak",
          level: "red",
          text: "The site's secret (OKS_SECRET) is missing, shorter than 32 characters, or still the example value. Set a long random one.",
        }
      : {
          key: "secret",
          area: "Security",
          title: "The sign-in secret is set",
          level: "green",
          text: "It is long enough and not an example value.",
        },
  );

  // Email.
  if (!(await emailWorks(runner, siteId)))
    add({
      key: "email-setup",
      area: "Email",
      title: "Email is not set up",
      level: "amber",
      text: "Password reset and invitations by email are off until it is.",
      fix: { label: "Set up email", href: "/admin/settings/email" },
    });
  else {
    add({
      key: "email-setup",
      area: "Email",
      title: "Email is set up",
      level: "green",
      text: "The site can send email.",
    });
    const mail = await emailHealth(runner, siteId, () => now);
    add(
      mail.problem
        ? {
            key: "email-sending",
            area: "Email",
            title: "Emails are not getting out",
            level: "red",
            text: mail.message,
            fix: { label: "Email settings", href: "/admin/settings/email" },
          }
        : {
            key: "email-sending",
            area: "Email",
            title: "Emails are going out",
            level: "green",
            text: "No run of failures was found.",
          },
    );
  }

  // Updates: the checks themselves.
  const word = {
    off: [
      "amber",
      "Update checks are off",
      "This site does not learn about new versions or security problems.",
    ],
    stale: [
      "amber",
      "The update list is old",
      "The newest list is more than 7 days old. Update checks may not be working.",
    ],
    failing: [
      "amber",
      "Update checks are failing",
      view.failure || "The last look at the update list did not work.",
    ],
    no_server: [
      "grey",
      "No update list yet",
      "No list has been received, so updates cannot be checked yet.",
    ],
    ok: ["green", "Update checks work", "The update list is up to date."],
  } as const;
  const [ulevel, utitle, utext] = word[view.health];
  add({
    key: "update-checks",
    area: "Updates",
    title: utitle,
    level: ulevel,
    text: utext,
    ...(view.health === "off" || view.health === "failing" || view.health === "stale"
      ? { fix: { label: "Updates", href: "/admin/tools/updates" } }
      : {}),
  });
  const waiting =
    (comparison?.core.behind ? 1 : 0) + (comparison?.items ?? []).filter((i) => i.behind).length;
  add({
    key: "updates-waiting",
    area: "Updates",
    title: waiting > 0 ? `${waiting} update(s) waiting` : "Everything is up to date",
    level: comparison ? "green" : "grey",
    text: comparison
      ? waiting > 0
        ? "A newer version of the core or a plugin is ready. It is not a security fix, so this is not a problem."
        : "No newer version is waiting."
      : "There is no update list yet.",
  });

  // Running.
  const beat = await loadHeartbeat(runner, siteId);
  add(
    beat === null
      ? {
          key: "jobs",
          area: "Running",
          title: "Scheduled jobs",
          level: "grey",
          text: "The job runner has not noted that it ran yet.",
        }
      : now - beat > 10 * 60 * 1000
        ? {
            key: "jobs",
            area: "Running",
            title: "The job runner has stopped",
            level: "red",
            text: "Scheduled posts, backups and emails are not being handled. Restart the server.",
          }
        : {
            key: "jobs",
            area: "Running",
            title: "Scheduled jobs are running",
            level: "green",
            text: "The job runner ran in the last 10 minutes.",
          },
  );
  const late = await runner.all(
    `select count(*) as n from "entries" where "site_id" = ? and "status" = 'scheduled' and "scheduled_at" <= ?`,
    [siteId, new Date(now - 5 * 60 * 1000)],
  );
  const lateCount = Number(late[0]?.["n"] ?? 0);
  add(
    lateCount > 0
      ? {
          key: "scheduled-posts",
          area: "Running",
          title: "Scheduled posts are late",
          level: "red",
          text: `${lateCount} post(s) are more than 5 minutes past their time and not yet published.`,
          count: lateCount,
        }
      : {
          key: "scheduled-posts",
          area: "Running",
          title: "Scheduled posts are on time",
          level: "green",
          text: "Nothing is waiting past its time.",
        },
  );
  add({
    key: "database",
    area: "Running",
    title: "The database answers",
    level: "green",
    text: "It answered the questions of this page.",
  });
  const free = facts.diskFreeBytes;
  const total = facts.diskTotalBytes;
  if (free === null)
    add({
      key: "disk",
      area: "Running",
      title: "Disk space",
      level: "grey",
      text: "This server cannot tell how much space is free.",
    });
  else {
    const share = total && total > 0 ? free / total : null;
    const red = free < 200 * MB || (share !== null && share < 0.02);
    const amber = free < 1 * GB || (share !== null && share < 0.1);
    add({
      key: "disk",
      area: "Running",
      title: red
        ? "The disk is almost full"
        : amber
          ? "The disk is getting full"
          : "There is enough disk space",
      level: red ? "red" : amber ? "amber" : "green",
      text: `${(free / GB).toFixed(1)} GB are free where the site keeps its files.${red || amber ? " Backups and uploads need room." : ""}`,
    });
  }

  // Plugins.
  const off = facts.plugins.filter((p) => p.status === "switched_off");
  add(
    off.length > 0
      ? {
          key: "plugins-off",
          area: "Plugins",
          title: "Plugins were switched off after problems",
          level: "amber",
          text: `${off
            .map((p) => p.name)
            .slice(0, 5)
            .join(", ")} ${off.length === 1 ? "was" : "were"} switched off because of problems.`,
          fix: { label: "Plugins", href: "/admin/tools/plugins" },
          count: off.length,
        }
      : {
          key: "plugins-off",
          area: "Plugins",
          title: "No plugin was switched off after problems",
          level: "green",
          text: "All installed plugins run as they should.",
        },
  );

  // Backups.
  const state = await loadBackupState(runner, siteId);
  const daily = await dailyBackupOn(runner, siteId);
  if (state.failedAt !== null)
    add({
      key: "backups",
      area: "Backups",
      title: "The last backup failed",
      level: "red",
      text: state.failure || "The daily backup could not be made.",
      fix: { label: "Backups", href: "/admin/tools/backups" },
    });
  else if (facts.lastGoodBackupAt === null)
    add({
      key: "backups",
      area: "Backups",
      title: "No backup was ever made",
      level: "amber",
      text: daily
        ? "The daily backup will make the first one."
        : "The daily backup is off, and no backup was made by hand.",
      fix: { label: "Backups", href: "/admin/tools/backups" },
    });
  else if (now - facts.lastGoodBackupAt > RECENT_MS)
    add({
      key: "backups",
      area: "Backups",
      title: "The newest backup is old",
      level: "amber",
      text: `The newest checked backup is ${Math.floor((now - facts.lastGoodBackupAt) / DAY)} days old.`,
      fix: { label: "Backups", href: "/admin/tools/backups" },
    });
  else
    add({
      key: "backups",
      area: "Backups",
      title: "The backups are fresh",
      level: "green",
      text: "The newest checked backup is less than two days old.",
    });

  // Hidden amber results leave the main list.
  const hiddenMap = await loadHidden(runner, siteId);
  const shown: HealthResult[] = [];
  const hidden: HealthReport["hidden"] = [];
  for (const result of r) {
    const e = hiddenMap[result.key];
    if (e && stillHidden(e, result, now))
      hidden.push({ ...result, hiddenBy: e.by, hiddenAt: e.at });
    else shown.push(result);
  }
  const order = { red: 0, amber: 1, grey: 2, green: 3 } as const;
  shown.sort((a, b) => order[a.level] - order[b.level]);
  const summary = { red: 0, amber: 0, grey: 0, green: 0 };
  for (const s of shown) summary[s.level] += 1;
  return { results: shown, hidden, summary };
}

/** "3 things need attention" or "Healthy" (grey results are not problems). */
export function healthLine(summary: HealthReport["summary"]): string {
  const n = summary.red + summary.amber;
  return n === 0 ? "Healthy" : n === 1 ? "1 thing needs attention" : `${n} things need attention`;
}

export type HideResult =
  { ok: true } | { ok: false; code: "forbidden" | "invalid" | "not_found"; message: string };

/** "I know, hide this": only an amber result, only for people who manage the settings. A red result can never be hidden (AD-74). */
export async function hideHealthCheck(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  report: HealthReport,
  key: unknown,
  byName: string,
  now: number = Date.now(),
): Promise<HideResult> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  if (typeof key !== "string")
    return { ok: false, code: "invalid", message: "The request was not understood." };
  const result = report.results.find((x) => x.key === key);
  if (!result) return { ok: false, code: "not_found", message: "There is no such check." };
  if (result.level !== "amber")
    return {
      ok: false,
      code: "invalid",
      message: "Only an amber result can be hidden. A red result needs action.",
    };
  const map = await loadHidden(runner, siteId);
  map[key] = {
    until: now + HIDE_DAYS * DAY,
    at: now,
    by: byName.slice(0, 100),
    level: "amber",
    count: result.count ?? null,
  };
  await write(runner, siteId, HEALTH_HIDDEN_KEY, map);
  return { ok: true };
}

/** Shows a hidden result again. */
export async function unhideHealthCheck(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  key: unknown,
): Promise<HideResult> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  if (typeof key !== "string")
    return { ok: false, code: "invalid", message: "The request was not understood." };
  const map = await loadHidden(runner, siteId);
  if (!(key in map)) return { ok: false, code: "not_found", message: "That result is not hidden." };
  delete map[key];
  await write(runner, siteId, HEALTH_HIDDEN_KEY, map);
  return { ok: true };
}
