// /api/admin/settings/media: GET the media settings, PUT to change them. Only people who manage the settings.
import { loadMediaSettingsForm, saveMediaSettings, type MediaSettingsForm } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";

export async function GET() {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const actor = await actorOf(member);
  if (!actor.can("settings.manage"))
    return reply({ code: "forbidden", message: "You may not see the settings." }, 403);
  return NextResponse.json({ settings: await loadMediaSettingsForm(getRunner(), member.siteId) });
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
  const patch: Partial<MediaSettingsForm> = {};
  if ("maxMegabytes" in input) patch.maxMegabytes = input["maxMegabytes"] as number;
  if ("maxMegapixels" in input) patch.maxMegapixels = input["maxMegapixels"] as number;
  if ("keepMetadata" in input) patch.keepMetadata = input["keepMetadata"] as boolean;
  const result = await saveMediaSettings(getRunner(), await actorOf(member), member.siteId, patch);
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  return NextResponse.json({ ok: true, settings: result.settings });
}
