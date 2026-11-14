// /api/admin/sections — the site's saved sections (spec 05, sections 17.6 and 17.10):
//   GET   every saved section, by name, with where each one is linked
//   POST  { name, group, blocks } saves blocks as a new section (published at once; it shows nowhere until placed)
// Only people who may change the site design (`themes.manage`).
import { createSavedSection, listSavedSections, sectionPlaces } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { LAYOUT_STATUS } from "./api-theme-layouts";
import { getRunner } from "./db";

export async function GET() {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const runner = getRunner();
  const result = await listSavedSections(runner, await actorOf(member), member.siteId);
  if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
  const sections = await Promise.all(
    result.sections.map(async (s) => ({
      ...s,
      places: (await sectionPlaces(runner, member.siteId, s.id)).length,
    })),
  );
  return NextResponse.json({ sections });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const result = await createSavedSection(getRunner(), await actorOf(member), member.siteId, {
    name: body["name"],
    group: body["group"],
    blocks: body["blocks"],
  });
  if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
  return NextResponse.json(
    { ok: true, section: result.section, repairs: result.repairs },
    { status: 201 },
  );
}
