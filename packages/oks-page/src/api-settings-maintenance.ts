// /api/admin/settings/maintenance: GET the maintenance settings, PUT to change them. Only people who manage the settings.
import { loadMaintenanceSettings, saveMaintenanceSettings } from "@oks-page/core";
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
  return NextResponse.json({
    settings: await loadMaintenanceSettings(getRunner(), member.siteId),
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
  const patch: { enabled?: boolean; message?: string } = {};
  if ("enabled" in input) patch.enabled = input["enabled"] as boolean;
  if ("message" in input) patch.message = input["message"] as string;
  const result = await saveMaintenanceSettings(
    getRunner(),
    await actorOf(member),
    member.siteId,
    patch,
  );
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  // Live in this process at once; other processes read it within a few seconds.
  forgetSetting("maintenance");
  return NextResponse.json({ ok: true, settings: result.settings });
}
