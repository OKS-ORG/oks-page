// /api/admin/settings/writing (Settings > Writing): GET the settings with the categories and layouts to choose from; PUT to
// change them. Only people who manage the settings.
import {
  layoutChoices,
  listCategoryChoices,
  loadWritingSettings,
  saveWritingSettings,
} from "@oks-page/core";
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
  return NextResponse.json({
    settings: await loadWritingSettings(getRunner(), member.siteId),
    categories: await listCategoryChoices(getRunner(), member.siteId),
    layouts: await layoutChoices(getRunner(), member.siteId),
  });
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
  const result = await saveWritingSettings(getRunner(), await actorOf(member), member.siteId, {
    defaultCategoryId: input["defaultCategoryId"],
    defaultLayout: input["defaultLayout"],
  });
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  return NextResponse.json({ ok: true, settings: result.settings });
}
