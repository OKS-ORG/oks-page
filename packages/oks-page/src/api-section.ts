// /api/admin/sections/<id> — one saved section (spec 05, sections 17.6 and 17.10):
//   GET     its published blocks and draft, its versions, where it is linked, and how many pages that reaches
//   PUT     { blocks } keeps the blocks as a draft (visitors see the published ones until Publish)
//   PATCH   { name?, group? } renames it or moves it to another group, at once
//   DELETE  ?draft=1 throws the draft away; without it, deletes the section after turning every link into a copy
//   POST    { action: "restore", versionId } makes a draft from a published version
// Only people who may change the site design (`themes.manage`); the server refuses everyone else (TH-77).
import {
  deleteSavedSection,
  entriesLinking,
  discardSectionDraft,
  getSavedSection,
  layoutUsage,
  listSectionVersions,
  loadThemeLayouts,
  restoreSectionVersion,
  saveSectionDraft,
  updateSavedSection,
} from "@oks-page/core";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { LAYOUT_STATUS } from "./api-theme-layouts";
import { getRunner } from "./db";

type Context = { params: Promise<{ id: string }> };

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function GET(_request: Request, context: Context) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const runner = getRunner();
  const actor = await actorOf(member);
  const result = await getSavedSection(runner, actor, member.siteId, id);
  if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
  const versions = await listSectionVersions(runner, actor, member.siteId, id);
  // How many pages the theme in use shows it on, for the banner ("Changes here show on 12 pages").
  const layouts = await loadThemeLayouts(runner, member.siteId, { drafts: true, split: true });
  const usage = layouts
    ? await layoutUsage(runner, member.siteId, layouts, `sections/${id}`)
    : null;
  return NextResponse.json({
    section: result.section,
    places: result.places,
    // The pages and posts that link to it, by title.
    entries: await entriesLinking(runner, member.siteId, id),
    versions: versions.ok ? versions.versions : [],
    usage,
  });
}

export async function PUT(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const body = await readBody(request);
  if (!body) return reply({ code: "invalid", message: "The request was not understood." }, 400);
  const result = await saveSectionDraft(
    getRunner(),
    await actorOf(member),
    member.siteId,
    id,
    body["blocks"],
  );
  if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
  return NextResponse.json({ ok: true, section: result.section, repairs: result.repairs });
}

export async function PATCH(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const body = await readBody(request);
  if (!body) return reply({ code: "invalid", message: "The request was not understood." }, 400);
  const result = await updateSavedSection(getRunner(), await actorOf(member), member.siteId, id, {
    name: body["name"],
    group: body["group"],
  });
  if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
  return NextResponse.json({ ok: true, section: result.section });
}

export async function DELETE(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const actor = await actorOf(member);
  if (new URL(request.url).searchParams.get("draft") === "1") {
    const result = await discardSectionDraft(getRunner(), actor, member.siteId, id);
    if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
    return NextResponse.json({ ok: true });
  }
  const result = await deleteSavedSection(getRunner(), actor, member.siteId, id);
  if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
  // Every page looks the same afterwards, but the stored layouts changed (links became copies).
  if (result.copied.length > 0) revalidateTag("theme", { expire: 0 });
  return NextResponse.json({ ok: true, copied: result.copied });
}

export async function POST(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  await context.params;
  const body = await readBody(request);
  if (!body || body["action"] !== "restore")
    return reply({ code: "invalid", message: "Say what to do: restore." }, 400);
  const result = await restoreSectionVersion(
    getRunner(),
    await actorOf(member),
    member.siteId,
    String(body["versionId"] ?? ""),
  );
  if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
  return NextResponse.json({ ok: true, section: result.section, repairs: result.repairs });
}
