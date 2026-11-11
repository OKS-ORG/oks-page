// PUT /api/admin/entries/[id]: save an entry. The core checks who may, repairs the blocks, writes the HTML and uses the
// revision rule; then the cached public page is refreshed.
import { saveContent } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { STATUS_OF, isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { refreshEntry } from "./refresh-cache";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
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
  const result = await saveContent(runner, await actorOf(member), member.siteId, id, {
    title: String(input["title"] ?? ""),
    slugPart: String(input["slugPart"] ?? ""),
    status: String(input["status"] ?? ""),
    blocks: input["blocks"],
    revision: Number(input["revision"]),
  });
  if (!result.ok) return reply(result, STATUS_OF[result.code]);
  refreshEntry(id, result.slug, String(before?.["slug"] ?? result.slug));
  return NextResponse.json({
    revision: result.revision,
    repairs: result.repairs,
    skippedBlocks: result.skippedBlocks,
    slug: result.slug,
    status: result.status,
  });
}
