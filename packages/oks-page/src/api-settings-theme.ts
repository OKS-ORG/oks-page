// /api/admin/settings/theme: GET the look (main color and fonts), PUT to change it. Only people who manage the settings.
import { loadThemeStyles, saveThemeStyles } from "@oks-page/core";
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
    return reply({ code: "forbidden", message: "You may not see the design." }, 403);
  return NextResponse.json({ styles: await loadThemeStyles(getRunner(), member.siteId) });
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
  const patch: {
    mainColor?: string | null;
    logoMediaId?: string | null;
    customCss?: string;
    bodyFont?: string;
    headingFont?: string;
    colorMode?: string;
    modeSwitch?: boolean;
  } = {};
  if ("mainColor" in input) patch.mainColor = input["mainColor"] as string | null;
  if ("logoMediaId" in input) patch.logoMediaId = input["logoMediaId"] as string | null;
  if ("customCss" in input) patch.customCss = input["customCss"] as string;
  if ("bodyFont" in input) patch.bodyFont = input["bodyFont"] as string;
  if ("headingFont" in input) patch.headingFont = input["headingFont"] as string;
  if ("colorMode" in input) patch.colorMode = input["colorMode"] as string;
  if ("modeSwitch" in input) patch.modeSwitch = input["modeSwitch"] as boolean;
  const result = await saveThemeStyles(getRunner(), await actorOf(member), member.siteId, patch);
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  // Every public page carries the look, so all of them are written again at the next request.
  revalidateTag("theme", { expire: 0 });
  return NextResponse.json({ ok: true, styles: result.styles });
}
