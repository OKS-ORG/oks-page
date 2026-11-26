// /api/admin/health (spec 07, section 16): POST { action } for Site health. Only people who manage the settings.
//   hide    { key }   "I know, hide this" for an amber result (a red result cannot be hidden)
//   show    { key }   shows a hidden result again
//   recheck {}        reads the certificate again; the page then shows the new results
import { hideHealthCheck, unhideHealthCheck } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { currentHealth, forgetCertificate } from "./health-context";

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
  if (!actor.can("settings.manage"))
    return reply({ code: "forbidden", message: "You may not change the site settings." }, 403);
  const runner = getRunner();
  switch (input["action"]) {
    case "hide": {
      const report = await currentHealth(runner, member.siteId, { probe: false });
      const done = await hideHealthCheck(
        runner,
        actor,
        member.siteId,
        report,
        input["key"],
        member.user.name || member.user.email,
      );
      if (!done.ok) return reply(done, STATUS[done.code]);
      return NextResponse.json({ ok: true });
    }
    case "show": {
      const done = await unhideHealthCheck(runner, actor, member.siteId, input["key"]);
      if (!done.ok) return reply(done, STATUS[done.code]);
      return NextResponse.json({ ok: true });
    }
    case "recheck":
      forgetCertificate();
      await currentHealth(runner, member.siteId, { probe: true });
      return NextResponse.json({ ok: true });
    default:
      return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
}
