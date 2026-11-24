// /api/admin/settings/privacy (Settings > Privacy): PUT to choose the privacy page; POST to write a draft privacy page
// from what the site really uses. Only people who manage the settings.
import {
  SMTP_PRESETS,
  loadEmailSettings,
  loadGeneralSettings,
  saveConsentTexts,
  writeAccessibilityStatementDraft,
  writeImprintDraft,
  saveStatisticsEnabled,
  statisticsEnabled,
  saveKeeping,
  savePrivacyPage,
  writePrivacyDraft,
} from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { statementDate, summariseAccessibility } from "./accessibility-summary";
import { loadConsentNeeds } from "./consent-needs";
import { forgetStatisticsSetting } from "./stats-collect";
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
  // Counting visitors on or off (spec 18, section 3).
  if (input["statistics"] !== undefined) {
    const saved = await saveStatisticsEnabled(
      getRunner(),
      await actorOf(member),
      member.siteId,
      (input["statistics"] as { enabled?: unknown } | null)?.enabled,
    );
    if (!saved.ok) return reply(saved, saved.code === "forbidden" ? 403 : 400);
    forgetStatisticsSetting();
    return NextResponse.json({ ok: true, enabled: saved.enabled });
  }
  // The words of the consent notice (spec 18, section 2) are saved on their own too.
  if (input["consentTexts"] !== undefined) {
    const saved = await saveConsentTexts(
      getRunner(),
      await actorOf(member),
      member.siteId,
      input["consentTexts"],
    );
    if (!saved.ok) return reply(saved, saved.code === "forbidden" ? 403 : 400);
    return NextResponse.json({ ok: true, texts: saved.texts });
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
  // A body asks for another kind of draft: the imprint, or the accessibility statement (spec 18, section 4).
  const sent = (await request.text()).trim();
  if (sent !== "") {
    let body: { draft?: unknown; imprint?: unknown; contactEmail?: unknown };
    try {
      body = JSON.parse(sent) as typeof body;
    } catch {
      return reply({ code: "invalid", message: "The request was not understood." }, 400);
    }
    const created = (r: { ok: true; id: string }) =>
      NextResponse.json({ ok: true, id: r.id, editUrl: `/admin/pages/${r.id}` }, { status: 201 });
    if (body.draft === "imprint") {
      const made = await writeImprintDraft(getRunner(), actor, member.siteId, body.imprint);
      if (!made.ok) return reply(made, made.code === "forbidden" ? 403 : 400);
      return created(made);
    }
    if (body.draft === "accessibility") {
      const general = await loadGeneralSettings(getRunner(), member.siteId);
      const summary = await summariseAccessibility(getRunner(), member.siteId);
      const made = await writeAccessibilityStatementDraft(getRunner(), actor, member.siteId, {
        siteName: general.siteName,
        contactEmail: typeof body.contactEmail === "string" ? body.contactEmail.trim() : "",
        date: statementDate(Date.now()),
        ...summary,
      });
      if (!made.ok) return reply(made, made.code === "forbidden" ? 403 : 400);
      return created(made);
    }
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
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
    statistics: await statisticsEnabled(getRunner(), member.siteId),
  });
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  return NextResponse.json(
    { ok: true, id: result.id, editUrl: `/admin/pages/${result.id}` },
    { status: 201 },
  );
}
