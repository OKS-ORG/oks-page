// /api/admin/agency (spec 11, section 6): POST { action } for the agency dashboard:
//   add     { code, name? }  connects a client site with the connection code made on it
//   check   {}               asks every connected site for its status, all at once, within a time budget
//   remove  { id }           disconnects a site
//   report  { id }           fetches one site's page and visit counts
// For people who manage the settings. Adding, checking and reports need an Agency key; removing never does.
import {
  addAgencySite,
  agencySiteLimit,
  agencyActive,
  checkAgencySites,
  fetchSiteReport,
  listLicences,
  removeAgencySite,
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
    case "report": {
      const done = await fetchSiteReport(runner, actor, member.siteId, siteSecrets(), id, ctx);
      if (!done.ok) return reply(done, STATUS[done.code]);
      return NextResponse.json({ ok: true, report: done.report });
    }
    default:
      return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
}
