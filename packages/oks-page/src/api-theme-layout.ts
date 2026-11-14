// /api/admin/themes/<id>/layout?key=templates/index — one layout of a theme:
//   GET     the theme's blocks, the owner's published and draft blocks, its state, and its published versions
//   PUT     { key, blocks } keeps the blocks as a draft (checked like page content, and with the other layouts)
//   DELETE  ?key=… throws the draft away
//   POST    { action: "keep-mine" | "reset", key } or { action: "restore", versionId }
// Only people who may change the site design (`themes.manage`).
import {
  deleteOwnerLayout,
  discardLayoutDraft,
  getLayout,
  keepMyLayout,
  layoutUsage,
  listLayoutVersions,
  loadThemeLayouts,
  loadThemeVersion,
  pagesChoosing,
  resetLayout,
  restoreLayoutVersion,
  saveLayoutDraft,
} from "@oks-page/core";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { LAYOUT_STATUS } from "./api-theme-layouts";
import { getRunner } from "./db";
import { refreshEntry } from "./refresh-cache";

type Context = { params: Promise<{ id: string }> };

const keyOf = (request: Request) => new URL(request.url).searchParams.get("key") ?? "";

export async function GET(request: Request, context: Context) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const actor = await actorOf(member);
  const key = keyOf(request);
  const result = await getLayout(getRunner(), actor, member.siteId, id, key);
  if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
  const versions = await listLayoutVersions(getRunner(), actor, member.siteId, id, key);
  // Where the layout shows, with the real numbers, for the editor's banner.
  const layouts = await loadThemeLayouts(getRunner(), member.siteId, { themeId: id, drafts: true });
  const usage = layouts ? await layoutUsage(getRunner(), member.siteId, layouts, key) : null;
  // For a named layout the owner made: the pages that chose it (listed before deleting it).
  const pages =
    result.layout.state === "owner-made" && key.startsWith("templates/")
      ? await pagesChoosing(getRunner(), member.siteId, key.slice("templates/".length))
      : [];
  return NextResponse.json({
    layout: result.layout,
    versions: versions.ok ? versions.versions : [],
    usage,
    pages,
  });
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function PUT(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const body = await readBody(request);
  if (!body) return reply({ code: "invalid", message: "The request was not understood." }, 400);
  const result = await saveLayoutDraft(
    getRunner(),
    await actorOf(member),
    member.siteId,
    id,
    String(body["key"] ?? ""),
    body["blocks"],
  );
  if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
  return NextResponse.json({ ok: true, layout: result.layout, repairs: result.repairs });
}

export async function DELETE(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const result = await discardLayoutDraft(
    getRunner(),
    await actorOf(member),
    member.siteId,
    id,
    keyOf(request),
  );
  if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
  return NextResponse.json({ ok: true });
}

export async function POST(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const body = await readBody(request);
  if (!body) return reply({ code: "invalid", message: "The request was not understood." }, 400);
  const actor = await actorOf(member);
  const key = String(body["key"] ?? "");
  const runner = getRunner();
  if (body["action"] === "keep-mine") {
    const result = await keepMyLayout(runner, actor, member.siteId, id, key);
    if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
    return NextResponse.json({ ok: true, layout: result.layout });
  }
  if (body["action"] === "reset") {
    const result = await resetLayout(runner, actor, member.siteId, id, key);
    if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
    if ((await loadThemeVersion(runner, member.siteId, id))?.isActive)
      revalidateTag("theme", { expire: 0 });
    return NextResponse.json({ ok: true });
  }
  if (body["action"] === "delete") {
    const result = await deleteOwnerLayout(runner, actor, member.siteId, id, key);
    if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
    for (const page of result.moved) refreshEntry(page.id, page.slug);
    if ((await loadThemeVersion(runner, member.siteId, id))?.isActive)
      revalidateTag("theme", { expire: 0 });
    return NextResponse.json({ ok: true, moved: result.moved });
  }
  if (body["action"] === "restore") {
    const result = await restoreLayoutVersion(
      runner,
      actor,
      member.siteId,
      id,
      String(body["versionId"] ?? ""),
    );
    if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
    return NextResponse.json({ ok: true, layout: result.layout, repairs: result.repairs });
  }
  return reply(
    { code: "invalid", message: "Say what to do: keep-mine, reset, restore or delete." },
    400,
  );
}
