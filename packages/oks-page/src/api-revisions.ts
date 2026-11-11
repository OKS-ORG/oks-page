// /api/admin/entries/[id]/revisions: GET lists the saved copies of an entry, or with ?compare=<copy id> compares one
// with the entry as it is now; POST {"revisionId", "revision"} puts a copy back as a new save.
import { compareRevision, listRevisions, restoreRevision } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { STATUS_OF, isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { refreshEntry } from "./refresh-cache";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const actor = await actorOf(member);
  const compare = new URL(request.url).searchParams.get("compare");
  if (compare) {
    const result = await compareRevision(getRunner(), actor, member.siteId, id, compare);
    if (!result.ok) return reply(result, STATUS_OF[result.code]);
    return NextResponse.json(result.compare);
  }
  const result = await listRevisions(getRunner(), actor, member.siteId, id);
  if (!result.ok) return reply(result, STATUS_OF[result.code]);
  return NextResponse.json({ revisions: result.revisions });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const runner = getRunner();
  const before = (await runner.all(`select "slug" from "entries" where "id" = ?`, [id]))[0];
  const result = await restoreRevision(
    runner,
    await actorOf(member),
    member.siteId,
    id,
    String(input["revisionId"] ?? ""),
    Number(input["revision"]),
  );
  if (!result.ok) return reply(result, STATUS_OF[result.code]);
  refreshEntry(id, result.slug, String(before?.["slug"] ?? result.slug));
  return NextResponse.json({ revision: result.revision, slug: result.slug, status: result.status });
}
