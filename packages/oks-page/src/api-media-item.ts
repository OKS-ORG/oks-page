// /api/admin/media/[id]: GET one file with the pages that use it, PATCH its descriptions, DELETE it.
import { deleteMedia, getMedia, updateMedia, type MediaPatch } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { MEDIA_STATUS } from "./api-media";
import { getRunner } from "./db";
import { refreshEntry } from "./refresh-cache";
import { mediaContext } from "./uploads";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const result = await getMedia(
    getRunner(),
    mediaContext(),
    await actorOf(member),
    member.siteId,
    id,
  );
  if (!result.ok) return reply(result, MEDIA_STATUS[result.code]);
  return NextResponse.json({ item: result.item, usedIn: result.usedIn, canEdit: result.canEdit });
}

const FIELDS = ["alt", "caption", "title", "description"] as const;

export async function PATCH(request: Request, context: Context) {
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
  const patch: MediaPatch = {};
  for (const key of FIELDS) if (key in input) patch[key] = input[key] as string;
  if ("focalX" in input) patch.focalX = input["focalX"] as number | null;
  if ("focalY" in input) patch.focalY = input["focalY"] as number | null;
  const result = await updateMedia(getRunner(), await actorOf(member), member.siteId, id, patch);
  if (!result.ok) return reply(result, MEDIA_STATUS[result.code]);
  // Pages that use the file may show its description: their cached copies are refreshed.
  for (const entryId of result.usedIn) {
    const row = (
      await getRunner().all(`select "slug" from "entries" where "id" = ?`, [entryId])
    )[0];
    if (row) refreshEntry(entryId, String(row["slug"]));
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const result = await deleteMedia(
    getRunner(),
    mediaContext(),
    await actorOf(member),
    member.siteId,
    id,
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: { code: result.code, message: result.message }, usedIn: result.usedIn ?? [] },
      { status: MEDIA_STATUS[result.code] },
    );
  }
  return NextResponse.json({ ok: true });
}
