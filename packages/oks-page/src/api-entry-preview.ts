// POST /api/admin/entries/[id]/preview-link: makes a signed link that shows the saved version of an entry to anyone who has
// it, until it expires ({"days": 1 to 30}, 7 by default). Only people who may edit the entry.
import { loadForEdit, makePreviewToken, previewExpiry } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { STATUS_OF, isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { siteOrigin } from "./site-origin";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  let input: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text) input = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const loaded = await loadForEdit(getRunner(), await actorOf(member), member.siteId, id);
  if (!loaded.ok) return reply(loaded, STATUS_OF[loaded.code]);
  const secret = process.env["OKS_SECRET"];
  if (!secret || secret.length < 32)
    return reply(
      { code: "invalid", message: "The site has no secret key, so it cannot make preview links." },
      500,
    );
  const expiresAt = previewExpiry(
    Date.now(),
    input["days"] === undefined ? undefined : Number(input["days"]),
  );
  if (expiresAt === null)
    return reply({ code: "invalid", message: "A link may last 1 to 30 days.", field: "days" }, 400);
  const url = `${siteOrigin(request)}/preview/${id}?t=${makePreviewToken(secret, id, expiresAt)}`;
  return NextResponse.json({ url, expiresAt: new Date(expiresAt).toISOString() }, { status: 201 });
}
