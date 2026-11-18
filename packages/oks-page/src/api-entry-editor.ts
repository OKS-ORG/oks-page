// /api/admin/entries/[id]/editor: GET what switching to the writing editor would lose; PUT {"editor", "anyway"} switches.
// A switch saves a revision first. A client cannot switch a page under a design lock; the server refuses it.
import { editorSwitchCost, switchEditor } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { refreshEntry } from "./refresh-cache";

const STATUS = {
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  would_lose: 409,
  conflict: 409,
} as const;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const result = await editorSwitchCost(getRunner(), await actorOf(member), member.siteId, id);
  if (!result.ok) return reply({ code: "not_found", message: result.message }, 404);
  return NextResponse.json({ editor: result.editor, lost: result.lost });
}

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
  const result = await switchEditor(
    getRunner(),
    await actorOf(member),
    member.siteId,
    id,
    input["editor"],
    {
      anyway: input["anyway"] === true,
    },
  );
  if (!result.ok)
    return NextResponse.json(
      {
        error: {
          code: result.code,
          message: result.message,
          ...(result.lost ? { lost: result.lost } : {}),
        },
      },
      { status: STATUS[result.code] },
    );
  refreshEntry(id, result.slug);
  return NextResponse.json({ ok: true, editor: result.editor, revision: result.revision });
}
