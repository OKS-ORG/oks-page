// /api/admin/entries/[id]/autosave: GET gives this person's unsaved copy (or null), PUT keeps a new one
// ({"title", "slugPart", "blocks", "revision"}), DELETE throws it away. It never changes the page itself.
import { discardAutosave, loadAutosave, saveAutosave } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { STATUS_OF, isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const result = await loadAutosave(getRunner(), await actorOf(member), member.siteId, id);
  if (!result.ok) return reply(result, STATUS_OF[result.code]);
  return NextResponse.json({ autosave: result.autosave });
}

export async function PUT(request: Request, context: Context) {
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
  const result = await saveAutosave(getRunner(), await actorOf(member), member.siteId, id, {
    title: String(input["title"] ?? ""),
    slugPart: String(input["slugPart"] ?? ""),
    blocks: input["blocks"],
    revision: Number(input["revision"]),
  });
  if (!result.ok) return reply(result, STATUS_OF[result.code]);
  return NextResponse.json({ savedAt: result.savedAt });
}

export async function DELETE(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const result = await discardAutosave(getRunner(), await actorOf(member), member.siteId, id);
  if (!result.ok) return reply(result, STATUS_OF[result.code]);
  return NextResponse.json({ ok: true });
}
