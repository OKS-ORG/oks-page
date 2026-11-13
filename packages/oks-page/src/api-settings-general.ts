// /api/admin/settings/general: GET the general settings, PUT to change them. Only people who manage the settings.
import { loadGeneralSettings, saveGeneralSettings, type GeneralSettings } from "@oks-page/core";
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
  return NextResponse.json({ settings: await loadGeneralSettings(getRunner(), member.siteId) });
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
  const patch: Partial<GeneralSettings> = {};
  if ("siteName" in input) patch.siteName = input["siteName"] as string;
  if ("tagline" in input) patch.tagline = input["tagline"] as string;
  if ("timeZone" in input) patch.timeZone = input["timeZone"] as string | null;
  const result = await saveGeneralSettings(
    getRunner(),
    await actorOf(member),
    member.siteId,
    patch,
  );
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  // The site's name and tagline are in every page's title and tags (and in the feeds).
  revalidateTag("settings", { expire: 0 });
  return NextResponse.json({ ok: true, settings: result.settings });
}
