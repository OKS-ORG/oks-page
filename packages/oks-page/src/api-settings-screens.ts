// /api/admin/settings/screens (Settings > Screen sizes): GET the sizes that are on; PUT to change them. Only people who
// manage the settings. Public pages draw the change at once.
import { loadScreenSizes, saveScreenSizes } from "@oks-page/core";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";

export async function GET() {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  if (!(await actorOf(member)).can("settings.manage"))
    return reply({ code: "forbidden", message: "You may not see the settings." }, 403);
  return NextResponse.json({ sizes: await loadScreenSizes(getRunner(), member.siteId) });
}

export async function PUT(request: Request) {
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
  const result = await saveScreenSizes(getRunner(), await actorOf(member), member.siteId, input);
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  revalidateTag("settings", { expire: 0 });
  return NextResponse.json({ ok: true, sizes: result.sizes });
}
