// POST /api/admin/entries: add a draft page or post. Needs a signed-in member who may add that kind of content.
import { createDraft, searchAdminEntries, type ContentErrorCode } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";

export const STATUS_OF: Record<ContentErrorCode, number> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  slug_taken: 409,
  conflict: 409,
  no_such_type: 400,
};

export const isSameOrigin = (request: Request): boolean => {
  const origin = request.headers.get("origin");
  return origin === null || new URL(origin).host === request.headers.get("host");
};

export const reply = (
  error: { code: string; message: string; field?: string; currentRevision?: number },
  status: number,
) => NextResponse.json({ error }, { status });

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let input: { type?: unknown; title?: unknown; editor?: unknown };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const result = await createDraft(getRunner(), await actorOf(member), member.siteId, {
    type: String(input.type ?? ""),
    title: String(input.title ?? ""),
    // A new page opens in the layout editor unless the writing editor is asked for; a post in the writing editor
    // (spec 06, 13.1, PB-80).
    editor: input.editor === "writing" || input.type !== "page" ? "writing" : "layout",
  });
  if (!result.ok) return reply(result, STATUS_OF[result.code]);
  return NextResponse.json({ id: result.id, slug: result.slug, revision: result.revision });
}

/** GET /api/admin/entries?q=...: the pages and posts the signed-in person may edit whose title holds the words (Ctrl+K). */
export async function GET(request: Request) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const hits = await searchAdminEntries(getRunner(), await actorOf(member), member.siteId, q);
  return NextResponse.json({ hits }, { headers: { "cache-control": "no-store" } });
}
