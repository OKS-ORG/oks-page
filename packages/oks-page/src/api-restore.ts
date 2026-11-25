// POST /api/admin/restore { token } (decision D60): puts the earlier version of a page back after a client changed it. The token is
// the one in the email's link, sealed with the site's secret. Only people who may publish. The page stays live.
import { restoreClientEdit } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { siteSecrets } from "./mail";
import { refreshEntry } from "./refresh-cache";

const STATUS = { forbidden: 403, invalid: 400, not_found: 404 } as const;

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let input: { token?: unknown };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const done = await restoreClientEdit(
    getRunner(),
    await actorOf(member),
    member.siteId,
    siteSecrets(),
    input.token,
  );
  if (!done.ok) return reply(done, STATUS[done.code]);
  refreshEntry(done.entryId, done.slug);
  return NextResponse.json({ ok: true, slug: done.slug });
}
