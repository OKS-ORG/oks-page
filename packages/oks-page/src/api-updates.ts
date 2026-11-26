// /api/admin/updates (spec 14, part 1): POST { action } for the update checks. Only people who manage the settings.
//   switch { on }   turns the update checks on or off
//   check  {}       looks at the list now
import { runUpdateCheck, runUrgentCheck, saveUpdateChecksOn } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { updateUrl, urgentUpdateUrl, userAgent } from "./updates-context";

const STATUS = { forbidden: 403, invalid: 400 } as const;

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
  switch (input["action"]) {
    case "switch": {
      const done = await saveUpdateChecksOn(runner, actor, member.siteId, input["on"]);
      if (!done.ok) return reply(done, STATUS[done.code]);
      return NextResponse.json({ ok: true, on: done.on });
    }
    case "check": {
      if (!actor.can("settings.manage"))
        return reply({ code: "forbidden", message: "You may not change the site settings." }, 403);
      const outcome = await runUpdateCheck(runner, member.siteId, {
        url: updateUrl(),
        userAgent: userAgent(),
      });
      // The urgent list too, when the site has an address for it; a refusal of it is told only when the main list was fine.
      const urgent = urgentUpdateUrl();
      if (urgent) {
        const second = await runUrgentCheck(runner, member.siteId, {
          url: urgent,
          userAgent: userAgent(),
        });
        if (second.status === "failed" || second.status === "refused")
          if (outcome.status !== "failed" && outcome.status !== "refused")
            return NextResponse.json({ ok: true, outcome: second });
      }
      return NextResponse.json({ ok: true, outcome });
    }
    default:
      return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
}
