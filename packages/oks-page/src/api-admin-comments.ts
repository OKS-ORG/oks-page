// /api/admin/comments: GET the comments with one status (and whether comments are on); PUT { enabled } to turn them on or
// off; PATCH { id, action } to approve, mark as spam, trash, restore or delete one. Only people who may moderate.
import {
  commentsEnabled,
  listComments,
  moderateComment,
  saveCommentsEnabled,
} from "@oks-page/core";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { refreshEntry } from "./refresh-cache";

const STATUS = { forbidden: 403, invalid: 400, not_found: 404, closed: 400 } as const;

export async function GET(request: Request) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const status = new URL(request.url).searchParams.get("status") ?? "pending";
  const listed = await listComments(getRunner(), await actorOf(member), member.siteId, status);
  if (!listed.ok) return reply(listed, STATUS[listed.code]);
  return NextResponse.json({
    enabled: await commentsEnabled(getRunner(), member.siteId),
    comments: listed.comments,
    counts: listed.counts,
  });
}

export async function PUT(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let input: { enabled?: unknown };
  try {
    input = (await request.json()) as { enabled?: unknown };
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const result = await saveCommentsEnabled(
    getRunner(),
    await actorOf(member),
    member.siteId,
    input.enabled,
  );
  if (!result.ok) return reply(result, STATUS[result.code]);
  // Posts show the comment form and the comments (or not) from the settings.
  revalidateTag("settings", { expire: 0 });
  return NextResponse.json({ ok: true, enabled: result.enabled });
}

export async function PATCH(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let input: { id?: unknown; action?: unknown };
  try {
    input = (await request.json()) as { id?: unknown; action?: unknown };
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const result = await moderateComment(
    getRunner(),
    await actorOf(member),
    member.siteId,
    String(input.id ?? ""),
    input.action,
  );
  if (!result.ok) return reply(result, STATUS[result.code]);
  // The post shows its approved comments, so its page is made fresh.
  refreshEntry(result.entryId, result.entrySlug);
  return NextResponse.json({ ok: true });
}
