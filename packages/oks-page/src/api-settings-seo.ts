// /api/admin/settings/seo: GET the search-engines setting, PUT to change it. Only people who manage the settings.
import { loadSeoSettings, saveSeoSettings } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { forgetSetting } from "./settings";

export async function GET() {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  if (!(await actorOf(member)).can("settings.manage"))
    return reply({ code: "forbidden", message: "You may not see the settings." }, 403);
  return NextResponse.json({ settings: await loadSeoSettings(getRunner(), member.siteId) });
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
  const patch: { discourageIndexing?: boolean } = {};
  if ("discourageIndexing" in input)
    patch.discourageIndexing = input["discourageIndexing"] as boolean;
  const result = await saveSeoSettings(getRunner(), await actorOf(member), member.siteId, patch);
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  // Live in this process at once; other processes read it within a few seconds.
  forgetSetting("seo");
  return NextResponse.json({ ok: true, settings: result.settings });
}
