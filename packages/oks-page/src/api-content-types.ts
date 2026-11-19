// /api/admin/content-types (Settings > Content types): GET the types with their fields; PUT to make or change one;
// DELETE ?key=... to remove one that has no entries. Only people who manage content types.
import {
  deleteContentType,
  listContentTypes,
  saveContentType,
  type ContentTypeInput,
} from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";

const STATUS = { forbidden: 403, invalid: 400, not_found: 404 } as const;

export async function GET() {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  if (!(await actorOf(member)).can("content_types.manage"))
    return reply({ code: "forbidden", message: "You may not see the content types." }, 403);
  return NextResponse.json({ types: await listContentTypes(getRunner(), member.siteId) });
}

export async function PUT(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let input: ContentTypeInput;
  try {
    input = (await request.json()) as ContentTypeInput;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const result = await saveContentType(getRunner(), await actorOf(member), member.siteId, input);
  if (!result.ok) return reply(result, STATUS[result.code]);
  return NextResponse.json({ ok: true, type: result.type });
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const key = new URL(request.url).searchParams.get("key") ?? "";
  const result = await deleteContentType(getRunner(), await actorOf(member), member.siteId, key);
  if (!result.ok) return reply(result, STATUS[result.code]);
  return NextResponse.json({ ok: true });
}
