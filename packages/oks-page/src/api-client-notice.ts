// PUT /api/admin/client-notice { enabled } (decision D60): whether the designers are emailed when a client changes a live page.
// People who manage the settings.
import { saveClientNoticeOn } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";

export async function PUT(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let input: { enabled?: unknown };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const done = await saveClientNoticeOn(
    getRunner(),
    await actorOf(member),
    member.siteId,
    input.enabled,
  );
  if (!done.ok) return reply(done, done.code === "forbidden" ? 403 : 400);
  return NextResponse.json({ ok: true, enabled: done.enabled });
}
