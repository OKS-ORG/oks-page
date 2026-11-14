// /api/admin/settings/advanced (Settings > Advanced): POST {"action": "clear-copies"} clears the saved copies of every
// public page, so the next visit to each one is made fresh (for when a change does not show). Only people who manage
// the settings; written to the audit log.
import { newId } from "@oks-page/db";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";

export const COPIES_CLEARED_KEY = "copies-cleared";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  if (!(await actorOf(member)).can("settings.manage"))
    return reply({ code: "forbidden", message: "You may not change the site settings." }, 403);
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  if (input["action"] !== "clear-copies")
    return reply({ code: "invalid", message: "Say what to do: clear-copies." }, 400);
  // Every saved answer of the public pages carries the tag "site".
  revalidateTag("site", { expire: 0 });
  const at = Date.now();
  const runner = getRunner();
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [member.siteId, COPIES_CLEARED_KEY, JSON.stringify({ at, by: member.user.name }), new Date(at)],
  );
  await runner.all(
    `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id",
      "detail", "created_at") values (?, ?, 'user', ?, 'cache.clear', 'site', ?, '{}', ?)`,
    [newId(), member.siteId, member.user.id, member.siteId, new Date(at)],
  );
  return NextResponse.json({ ok: true, at, by: member.user.name });
}
