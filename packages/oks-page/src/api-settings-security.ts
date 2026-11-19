// /api/admin/settings/security: GET the security settings, PUT to change them. Only people who manage the settings.
import {
  dismissBlockedStyle,
  listBlockedStyles,
  loadSecuritySettings,
  saveSecuritySettings,
} from "@oks-page/core";
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
  return NextResponse.json({
    settings: await loadSecuritySettings(getRunner(), member.siteId),
    blocked: await listBlockedStyles(getRunner(), member.siteId),
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
  // "Not now" on a blocked host: forget it (the host stays blocked).
  if ("dismissBlocked" in input) {
    const gone = await dismissBlockedStyle(
      getRunner(),
      await actorOf(member),
      member.siteId,
      input["dismissBlocked"],
    );
    if (!gone.ok) return reply(gone, gone.code === "forbidden" ? 403 : 400);
    return NextResponse.json({
      ok: true,
      blocked: await listBlockedStyles(getRunner(), member.siteId),
    });
  }
  const patch: { requireTwoFactorForAdmins?: boolean; styleHosts?: string[] } = {};
  if ("requireTwoFactorForAdmins" in input)
    patch.requireTwoFactorForAdmins = input["requireTwoFactorForAdmins"] as boolean;
  // Checked in the core (a wildcard, http, a port or a path is refused with the reason).
  if ("styleHosts" in input) patch.styleHosts = input["styleHosts"] as string[];
  const result = await saveSecuritySettings(
    getRunner(),
    await actorOf(member),
    member.siteId,
    patch,
  );
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  return NextResponse.json({
    ok: true,
    settings: result.settings,
    blocked: await listBlockedStyles(getRunner(), member.siteId),
  });
}
