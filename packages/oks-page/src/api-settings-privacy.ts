// /api/admin/settings/privacy (Settings > Privacy): PUT to choose the privacy page; POST to write a draft privacy page
// from what the site really uses. Only people who manage the settings.
import {
  SMTP_PRESETS,
  loadEmailSettings,
  loadGeneralSettings,
  saveKeeping,
  savePrivacyPage,
  writePrivacyDraft,
} from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { loadConsentNeeds } from "./consent-needs";
import { getRunner } from "./db";

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
  // The times personal data is kept for (spec 18, section 6) are saved on their own, apart from the privacy page.
  if (input["keeping"] !== undefined) {
    const saved = await saveKeeping(
      getRunner(),
      await actorOf(member),
      member.siteId,
      input["keeping"],
    );
    if (!saved.ok) return reply(saved, saved.code === "forbidden" ? 403 : 400);
    return NextResponse.json({ ok: true, keeping: saved.keeping });
  }
  const result = await savePrivacyPage(
    getRunner(),
    await actorOf(member),
    member.siteId,
    input["pageId"] ?? null,
  );
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  return NextResponse.json({ ok: true, settings: result.settings });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const actor = await actorOf(member);
  const email = await loadEmailSettings(getRunner(), actor, member.siteId);
  if (!email.ok) return reply(email, 403);
  const general = await loadGeneralSettings(getRunner(), member.siteId);
  const provider = email.settings?.working
    ? (SMTP_PRESETS.find((p) => p.key === email.settings?.provider)?.label ?? "your email provider")
    : null;
  const needs = await loadConsentNeeds(getRunner(), member.siteId);
  const result = await writePrivacyDraft(getRunner(), actor, member.siteId, {
    siteName: general.siteName,
    emailProvider: provider,
    pluginUses: needs.plugins.map((p) => ({
      plugin: p.plugin,
      cookies: p.cookies,
      hosts: p.outsideHosts,
    })),
    loadAtOnce: needs.videos.map((v) => v.company),
  });
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  return NextResponse.json(
    { ok: true, id: result.id, editUrl: `/admin/pages/${result.id}` },
    { status: 201 },
  );
}
