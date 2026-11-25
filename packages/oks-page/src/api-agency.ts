// /api/admin/agency (spec 11, section 6): POST { action } for the agency dashboard:
//   add     { code, name? }  connects a client site with the connection code made on it
//   check   {}               asks every connected site for its status, all at once, within a time budget
//   remove  { id }           disconnects a site
//   backup  { id }           asks a client site to make a backup now
//   report  { id, days? }    fetches one site's page and visit counts (7, 30 or 90 days)
//   email-report { id, days?, to, note? }  sends the client's report by email from this site
// For people who manage the settings. Adding, checking and reports need an Agency key; removing never does.
import {
  addAgencySite,
  agencySiteLimit,
  agencyActive,
  checkAgencySites,
  emailClientReport,
  fetchSiteReport,
  listLicences,
  loadGeneralSettings,
  loadWhiteLabel,
  removeAgencySite,
  requestSiteBackup,
} from "@oks-page/core";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { licencePublicKeys } from "./licence-keys";
import { siteSecrets } from "./mail";

const STATUS = { forbidden: 403, invalid: 400, not_found: 404 } as const;

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const actor = await actorOf(member);
  const runner = getRunner();
  const host = ((await headers()).get("host") ?? "").replace(/:\d+$/, "");
  const licences = await listLicences(runner, member.siteId, licencePublicKeys());
  const now = new Date();
  const ctx = {
    fetch: globalThis.fetch,
    now: Date.now,
    timeoutMs: 8_000,
    agency: {
      active: agencyActive(licences, host, now),
      limit: agencySiteLimit(licences, host, now),
    },
  };
  const id = typeof input["id"] === "string" ? input["id"] : "";
  switch (input["action"]) {
    case "add": {
      const done = await addAgencySite(
        runner,
        actor,
        member.siteId,
        siteSecrets(),
        input as { code: unknown; name?: unknown },
        ctx,
      );
      if (!done.ok) return reply(done, STATUS[done.code]);
      return NextResponse.json({ ok: true, site: done.site });
    }
    case "check": {
      const done = await checkAgencySites(runner, actor, member.siteId, siteSecrets(), {
        ...ctx,
        budgetMs: 20_000,
      });
      if (!done.ok) return reply(done, STATUS[done.code]);
      return NextResponse.json({ ok: true, sites: done.sites });
    }
    case "remove": {
      const done = await removeAgencySite(runner, actor, member.siteId, id);
      if (!done.ok) return reply(done, STATUS[done.code]);
      return NextResponse.json({ ok: true });
    }
    case "backup": {
      const done = await requestSiteBackup(runner, actor, member.siteId, siteSecrets(), id, ctx);
      if (!done.ok) return reply(done, STATUS[done.code]);
      return NextResponse.json({ ok: true, backup: done.backup });
    }
    case "report": {
      const days = input["days"] === undefined ? 30 : Number(input["days"]);
      const done = await fetchSiteReport(
        runner,
        actor,
        member.siteId,
        siteSecrets(),
        id,
        ctx,
        days,
      );
      if (!done.ok) return reply(done, STATUS[done.code]);
      return NextResponse.json({ ok: true, report: done.report });
    }
    case "email-report": {
      const days = input["days"] === undefined ? 30 : Number(input["days"]);
      // The report is signed with the agency's own name (its white-label name when it has one).
      const wl = await loadWhiteLabel(runner, member.siteId);
      const preparedBy = wl.name || (await loadGeneralSettings(runner, member.siteId)).siteName;
      const done = await emailClientReport(
        runner,
        actor,
        member.siteId,
        siteSecrets(),
        { id, days, to: input["to"], note: input["note"] },
        ctx,
        preparedBy,
      );
      if (!done.ok) return reply(done, STATUS[done.code]);
      return NextResponse.json({ ok: true });
    }
    default:
      return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
}
