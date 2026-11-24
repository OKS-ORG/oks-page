// /api/admin/handoff (spec 11, section 9): PUT { done: [item ids] } saves which items of the handoff checklist are marked done.
// Only people who manage the settings.
import { saveHandoff } from "@oks-page/core";
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
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const result = await saveHandoff(getRunner(), await actorOf(member), member.siteId, input);
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  return NextResponse.json({ ok: true, done: result.done });
}
