// Requests from visitors to see or delete their personal data (spec 18, section 5; PR-06). A visitor gives an address and what
// they want; the site emails that address a link, and nothing is exported or deleted for the request until the person has
// opened it (a safety rule: otherwise anyone could ask for someone else's data). The owner sees the confirmed requests in
// Tools > Privacy requests with the day the answer is due (30 days) and answers them with the same tool as before. The site
// keeps the address as a hash for matching and sealed with its own secret only until the request is answered; the link is
// kept as a hash. Every step goes in the audit log, without the address.
import type { Actor, SiteSecrets } from "@oks-page/core";
import { newId, type SqlRunner } from "@oks-page/db";
import { createHash, randomBytes } from "node:crypto";
import { emailHash, normalizeEmail } from "./privacy-requests";

export type RequestKind = "export" | "delete";
const KINDS: RequestKind[] = ["export", "delete"];

const DAY = 24 * 60 * 60 * 1000;
/** How long the link in the confirmation email works. */
export const LINK_DAYS = 7;
/** The time the owner has to answer, from the day the person confirmed (spec 18, section 5). */
export const ANSWER_DAYS = 30;
/** An answered request is kept this long, as a record, then deleted. */
export const ANSWERED_KEEP_DAYS = 365;
/** The same address gets one confirmation email an hour, so the form cannot be used to fill someone's inbox. */
const REPEAT_MS = 60 * 60 * 1000;

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
const place = (id: string): string => `privacy-request:${id}`;
const words = (kind: RequestKind): string => (kind === "export" ? "send a copy of" : "delete");

export interface CreateDeps {
  secrets: SiteSecrets;
  /** The address of the site, for the link in the email. */
  origin: string;
  siteName: string;
  /** Puts the email in the queue; false when email cannot be sent. */
  queue: (to: string, subject: string, text: string, expiresAt: number) => Promise<boolean>;
  now?: () => number;
}

export type CreateResult =
  { ok: true } | { ok: false; code: "invalid" | "unavailable"; message: string };

const audit = (
  runner: SqlRunner,
  siteId: string,
  actorType: "user" | "system",
  actorId: string,
  action: string,
  hash: string,
  detail: Record<string, unknown>,
  at: number,
) =>
  runner.all(
    `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id", "detail", "created_at") values (?, ?, ?, ?, ?, 'privacy', ?, ?, ?)`,
    [newId(), siteId, actorType, actorId, action, hash, JSON.stringify(detail), new Date(at)],
  );

/**
 * A visitor asks to see or delete their data. The same answer is given whether or not the site keeps anything about the
 * address (so the form cannot be used to find out), and an address that was asked about in the last hour gets no second email.
 */
export async function createPrivacyRequest(
  runner: SqlRunner,
  siteId: string,
  input: { email: unknown; kind: unknown },
  deps: CreateDeps,
): Promise<CreateResult> {
  const now = deps.now ?? Date.now;
  const email = normalizeEmail(input.email);
  if (!email) return { ok: false, code: "invalid", message: "Enter a valid email address." };
  const kind = KINDS.find((k) => k === input.kind);
  if (!kind) return { ok: false, code: "invalid", message: "Choose what you would like." };
  const hash = emailHash(email);
  const recent = await runner.all(
    `select 1 as "x" from "privacy_requests" where "site_id" = ? and "email_hash" = ? and "created_at" > ?`,
    [siteId, hash, new Date(now() - REPEAT_MS)],
  );
  if (recent.length > 0) return { ok: true };
  const id = newId();
  const token = randomBytes(32).toString("base64url");
  const expires = now() + LINK_DAYS * DAY;
  await runner.all(
    `insert into "privacy_requests" ("id", "site_id", "email_hash", "email_sealed", "kind", "status", "token_hash", "created_at", "expires_at")
     values (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [
      id,
      siteId,
      hash,
      deps.secrets.seal(email, place(id)),
      kind,
      hashToken(token),
      new Date(now()),
      new Date(expires),
    ],
  );
  const queued = await deps.queue(
    email,
    `Please confirm your request: ${deps.siteName}`,
    [
      `Someone, hopefully you, asked ${deps.siteName} to ${words(kind)} the personal data the site keeps about this email address.`,
      "",
      `To confirm that this was you, open this link (it works for ${LINK_DAYS} days):`,
      `${deps.origin.replace(/\/$/, "")}/privacy-request/confirm/${token}`,
      "",
      "If it was not you, ignore this email: nothing will happen.",
      "",
      deps.siteName,
    ].join("\n"),
    expires,
  );
  if (!queued) {
    // No email can go out, so the request could never be confirmed: it is not kept.
    await runner.all(`delete from "privacy_requests" where "id" = ?`, [id]);
    return {
      ok: false,
      code: "unavailable",
      message:
        "This site cannot send the confirmation email right now. Please write to the site owner instead.",
    };
  }
  await audit(runner, siteId, "system", "visitor", "privacy.request", hash, { kind }, now());
  return { ok: true };
}

export interface ConfirmDeps {
  origin: string;
  /** Tells an administrator by email; false when it could not be queued. */
  notify: (siteId: string, to: string, subject: string, text: string) => Promise<boolean>;
  now?: () => number;
}

export type ConfirmResult = { ok: true; kind: RequestKind; already: boolean } | { ok: false };

/** The person opened the link in their email. A link that is wrong, used up or past its week confirms nothing. */
export async function confirmPrivacyRequest(
  runner: SqlRunner,
  token: string,
  deps: ConfirmDeps,
): Promise<ConfirmResult> {
  const now = (deps.now ?? Date.now)();
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return { ok: false };
  const row = (
    await runner.all(
      `select "id", "site_id", "kind", "status", "email_hash", "expires_at" from "privacy_requests" where "token_hash" = ?`,
      [hashToken(token)],
    )
  )[0];
  if (!row) return { ok: false };
  const kind = String(row["kind"]) as RequestKind;
  if (String(row["status"]) !== "pending") return { ok: true, kind, already: true };
  if (new Date(row["expires_at"] as string | number | Date).getTime() < now) return { ok: false };
  const changed = await runner.all(
    `update "privacy_requests" set "status" = 'confirmed', "confirmed_at" = ? where "id" = ? and "status" = 'pending' returning "id"`,
    [new Date(now), String(row["id"])],
  );
  if (changed.length === 0) return { ok: true, kind, already: true };
  const siteId = String(row["site_id"]);
  await audit(
    runner,
    siteId,
    "system",
    "visitor",
    "privacy.request_confirmed",
    String(row["email_hash"]),
    { kind },
    now,
  );
  // The owner is told, so the 30 days do not start unseen. A failure to tell never undoes the confirmation.
  try {
    const admins = await runner.all(
      `select u."email" from "site_members" m join "users" u on u."id" = m."user_id"
        join "roles" r on r."id" = m."role_id" where m."site_id" = ? and r."key" = 'administrator'`,
      [siteId],
    );
    for (const a of admins)
      await deps.notify(
        siteId,
        String(a["email"]),
        "A privacy request was confirmed",
        [
          `Someone confirmed a request to ${words(kind)} the personal data your site keeps about them.`,
          `You have ${ANSWER_DAYS} days to answer it. Open Tools > Privacy requests:`,
          `${deps.origin.replace(/\/$/, "")}/admin/tools/privacy`,
        ].join("\n"),
      );
  } catch {
    /* the request stays confirmed and shows in the list */
  }
  return { ok: true, kind, already: false };
}

export interface OpenRequest {
  id: string;
  kind: RequestKind;
  confirmedAt: number;
  /** The day the answer is due: 30 days after the person confirmed. */
  dueAt: number;
  /** True when that day has passed. */
  overdue: boolean;
  /** The address, or null when it can no longer be read (the site's secret was changed). */
  email: string | null;
}

export type OwnerResult<T> =
  ({ ok: true } & T) | { ok: false; code: "forbidden" | "not_found"; message: string };

const forbidden = {
  ok: false,
  code: "forbidden",
  message: "You may not handle privacy requests.",
} as const;

/** What the owner sees: confirmed requests waiting for an answer (with the address), and how many are waiting for the person. */
export async function listPrivacyRequests(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  secrets: SiteSecrets,
  now: () => number = Date.now,
): Promise<OwnerResult<{ waiting: number; open: OpenRequest[]; answered: number }>> {
  if (!actor.can("settings.manage")) return forbidden;
  const count = async (where: string, ...params: unknown[]) =>
    Number(
      (
        await runner.all(
          `select count(*) as "n" from "privacy_requests" where "site_id" = ? and ${where}`,
          [siteId, ...params],
        )
      )[0]!["n"],
    );
  const rows = await runner.all(
    `select "id", "kind", "email_sealed", "confirmed_at" from "privacy_requests" where "site_id" = ? and "status" = 'confirmed' order by "confirmed_at", "id"`,
    [siteId],
  );
  const open: OpenRequest[] = rows.map((r) => {
    const confirmedAt = new Date(r["confirmed_at"] as string | number | Date).getTime();
    let email: string | null;
    try {
      email = secrets.open(String(r["email_sealed"]), place(String(r["id"])));
    } catch {
      email = null;
    }
    return {
      id: String(r["id"]),
      kind: String(r["kind"]) as RequestKind,
      confirmedAt,
      dueAt: confirmedAt + ANSWER_DAYS * DAY,
      overdue: now() >= confirmedAt + ANSWER_DAYS * DAY,
      email,
    };
  });
  return {
    ok: true,
    open,
    waiting: await count(`"status" = 'pending' and "expires_at" > ?`, new Date(now())),
    answered: await count(`"status" = 'answered'`),
  };
}

/** The owner has answered a request: it is marked, and the address is wiped. */
export async function answerPrivacyRequest(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
  now: () => number = Date.now,
): Promise<OwnerResult<object>> {
  if (!actor.can("settings.manage")) return forbidden;
  const row = (
    await runner.all(
      `update "privacy_requests" set "status" = 'answered', "done_at" = ?, "email_sealed" = null where "id" = ? and "site_id" = ? and "status" = 'confirmed' returning "email_hash", "kind"`,
      [new Date(now()), id, siteId],
    )
  )[0];
  if (!row)
    return { ok: false, code: "not_found", message: "This request is not waiting for an answer." };
  await audit(
    runner,
    siteId,
    "user",
    actor.userId,
    "privacy.request_answered",
    String(row["email_hash"]),
    { kind: String(row["kind"]) },
    now(),
  );
  return { ok: true };
}

/** Requests whose link ran out are forgotten, and so are answered ones after a year. Returns how many went. */
export async function purgePrivacyRequests(
  runner: SqlRunner,
  now: () => number = Date.now,
): Promise<number> {
  const a = await runner.all(
    `delete from "privacy_requests" where "status" = 'pending' and "expires_at" < ? returning "id"`,
    [new Date(now())],
  );
  const b = await runner.all(
    `delete from "privacy_requests" where "status" = 'answered' and "done_at" < ? returning "id"`,
    [new Date(now() - ANSWERED_KEEP_DAYS * DAY)],
  );
  return a.length + b.length;
}

/** The administrators are reminded this many days before the answer is due. */
export const REMIND_DAYS = 7;

export interface ReminderDeps {
  /** Puts an email to an administrator in the queue; false when email cannot be sent. */
  queue: (siteId: string, to: string, subject: string, text: string) => Promise<boolean>;
  /** The address of the site, for the link in the email; without it the email names the place to look. */
  origin?: string | undefined;
  now?: () => number;
}

/**
 * Reminds the administrators of a site about confirmed requests that are nearly due or overdue, so the 30 days do not run out
 * unseen (spec 18, section 5). Each request gets at most two emails: one when 7 days are left and one when it is overdue. The
 * email names how many requests, never who they are. A reminder is counted as sent only when it was queued for at least one
 * administrator, so a site that cannot send email is tried again at the next run. Returns how many requests it reminded about.
 */
export async function sendPrivacyReminders(
  runner: SqlRunner,
  deps: ReminderDeps,
): Promise<{ soon: number; overdue: number }> {
  const now = (deps.now ?? Date.now)();
  const rows = await runner.all(
    `select "id", "site_id", "email_hash", "confirmed_at", "reminder_stage" from "privacy_requests" where "status" = 'confirmed' and "reminder_stage" < 2`,
  );
  const bySite = new Map<string, { id: string; hash: string; stage: 1 | 2 }[]>();
  for (const r of rows) {
    const due = new Date(r["confirmed_at"] as string | number | Date).getTime() + ANSWER_DAYS * DAY;
    const stage: 0 | 1 | 2 = now >= due ? 2 : now >= due - REMIND_DAYS * DAY ? 1 : 0;
    if (stage === 0 || stage <= Number(r["reminder_stage"])) continue;
    const list = bySite.get(String(r["site_id"])) ?? [];
    list.push({ id: String(r["id"]), hash: String(r["email_hash"]), stage });
    bySite.set(String(r["site_id"]), list);
  }
  const done = { soon: 0, overdue: 0 };
  const where = deps.origin
    ? `Open Tools > Privacy requests: ${deps.origin.replace(/\/$/, "")}/admin/tools/privacy`
    : "Open Tools > Privacy requests in your admin.";
  for (const [siteId, due] of bySite) {
    const admins = await runner.all(
      `select u."email" from "site_members" m join "users" u on u."id" = m."user_id"
        join "roles" r on r."id" = m."role_id" where m."site_id" = ? and r."key" = 'administrator'`,
      [siteId],
    );
    for (const stage of [2, 1] as const) {
      const these = due.filter((d) => d.stage === stage);
      if (these.length === 0) continue;
      const many =
        these.length === 1
          ? "A confirmed privacy request"
          : `${these.length} confirmed privacy requests`;
      const subject =
        stage === 2 ? "A privacy request is overdue" : "A privacy request is due soon";
      const text =
        stage === 2
          ? `${many} ${these.length === 1 ? "is" : "are"} past the ${ANSWER_DAYS} days you have to answer. Please answer ${these.length === 1 ? "it" : "them"} now.\n${where}`
          : `${many} must be answered within ${REMIND_DAYS} days (${ANSWER_DAYS} days after the person confirmed it).\n${where}`;
      let sent = false;
      for (const a of admins)
        if (await deps.queue(siteId, String(a["email"]), subject, text)) sent = true;
      if (!sent) continue;
      for (const d of these) {
        await runner.all(
          `update "privacy_requests" set "reminder_stage" = ? where "id" = ? and "status" = 'confirmed' and "reminder_stage" < ?`,
          [stage, d.id, stage],
        );
        await audit(
          runner,
          siteId,
          "system",
          "reminder",
          "privacy.request_reminder",
          d.hash,
          { stage },
          now,
        );
      }
      if (stage === 2) done.overdue += these.length;
      else done.soon += these.length;
    }
  }
  return done;
}
