// /api/admin/settings/email (spec 13, section 3): GET the email settings (never the password), the presets and the
// email record; PUT the settings with a test address: they are saved only when the test email is accepted (EM-01);
// DELETE turns email off. Only people who manage the settings.
import {
  listEmailLog,
  loadEmailSettings,
  loadGeneralSettings,
  saveEmailSettings,
  SMTP_PRESETS,
  turnEmailOff,
} from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { siteSecrets } from "./mail";

export async function GET() {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const actor = await actorOf(member);
  const settings = await loadEmailSettings(getRunner(), actor, member.siteId);
  if (!settings.ok) return reply(settings, 403);
  const log = await listEmailLog(getRunner(), actor, member.siteId);
  return NextResponse.json({
    settings: settings.settings,
    presets: SMTP_PRESETS,
    log: log.ok ? log.rows : [],
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
  const general = await loadGeneralSettings(getRunner(), member.siteId);
  const result = await saveEmailSettings(
    getRunner(),
    await actorOf(member),
    member.siteId,
    siteSecrets(),
    input,
    { siteName: general.siteName },
  );
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  return NextResponse.json({ ok: true, settings: result.settings });
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const result = await turnEmailOff(getRunner(), await actorOf(member), member.siteId);
  if (!result.ok) return reply(result, 403);
  return NextResponse.json({ ok: true });
}
