// /api/admin/redirects: GET the redirects, POST to add one. /api/admin/redirects/[id] (api-redirect.ts) deletes one.
// Only people who manage the settings.
import { addRedirect, listRedirects } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";

export const REDIRECT_STATUS = { forbidden: 403, invalid: 400, not_found: 404 } as const;

export async function GET() {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  if (!(await actorOf(member)).can("settings.manage"))
    return reply({ code: "forbidden", message: "You may not see the redirects." }, 403);
  return NextResponse.json({ redirects: await listRedirects(getRunner(), member.siteId) });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const result = await addRedirect(getRunner(), await actorOf(member), member.siteId, {
    from: String(input["from"] ?? ""),
    to: String(input["to"] ?? ""),
    ...(input["status"] === undefined ? {} : { status: Number(input["status"]) }),
  });
  if (!result.ok) return reply(result, REDIRECT_STATUS[result.code]);
  return NextResponse.json({ ok: true, from: result.from, to: result.to }, { status: 201 });
}
