// PUT /api/admin/entries/[id]: save an entry. The core checks who may, repairs the blocks, writes the HTML and uses the
// revision rule; then the cached public page is refreshed. DELETE moves an entry to the trash (or, with ?forever=1,
// deletes one that is already in the trash); PATCH with {"action": "restore"} brings it back as a draft.
import { deleteForever, restoreEntry, saveContent, trashEntry } from "@oks-page/core";
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

async function member_(request: Request) {
  if (!isSameOrigin(request))
    return {
      error: reply({ code: "forbidden", message: "This request came from another address." }, 403),
    };
  const member = await signedInMember();
  if (!member) return { error: reply({ code: "forbidden", message: "Sign in first." }, 401) };
  return { member };
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const who = await member_(request);
  if (!who.member) return who.error;
  const { id } = await context.params;
  const runner = getRunner();
  const actor = await actorOf(who.member);
  if (new URL(request.url).searchParams.get("forever") === "1") {
    const gone = await deleteForever(runner, actor, who.member.siteId, id);
    if (!gone.ok) return reply(gone, STATUS_OF[gone.code]);
    return NextResponse.json({ ok: true });
  }
  const before = (await runner.all(`select "slug" from "entries" where "id" = ?`, [id]))[0];
  const moved = await trashEntry(runner, actor, who.member.siteId, id);
  if (!moved.ok) return reply(moved, STATUS_OF[moved.code]);
  if (before) refreshEntry(id, String(before["slug"]));
  return NextResponse.json({ ok: true });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const who = await member_(request);
  if (!who.member) return who.error;
  const { id } = await context.params;
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  if (input["action"] !== "restore")
    return reply({ code: "invalid", message: "This action is not known." }, 400);
  const back = await restoreEntry(getRunner(), await actorOf(who.member), who.member.siteId, id);
  if (!back.ok) return reply(back, STATUS_OF[back.code]);
  return NextResponse.json({ ok: true, slug: back.slug });
}
