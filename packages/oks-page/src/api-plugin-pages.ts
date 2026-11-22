// /api/admin/plugin-pages: GET ?plugin=&page= (&filter=&after=) the rows of a plugin's admin page; GET with &export=1 the
// same items as a CSV file; POST { plugin, page, action, key } does what a button on a row does. Only people who manage plugins.
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { actOnPluginPage, exportPluginPage, loadPluginPage } from "./plugin-pages";

const STATUS = { forbidden: 403, invalid: 400, not_found: 404 } as const;

export async function GET(request: Request) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const q = new URL(request.url).searchParams;
  const plugin = q.get("plugin") ?? "";
  const page = q.get("page") ?? "";
  const filterText = q.get("filter");
  const filter =
    filterText !== null && /^\d{1,2}$/.test(filterText) ? Number(filterText) : undefined;
  const actor = await actorOf(member);
  if (q.get("export") === "1") {
    const made = await exportPluginPage(getRunner(), actor, member.siteId, plugin, page, filter);
    if (!made.ok) return reply(made, STATUS[made.code]);
    return new Response(made.csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${made.filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(made.cut ? { "x-oks-export-cut": "1" } : {}),
      },
    });
  }
  const result = await loadPluginPage(getRunner(), actor, member.siteId, plugin, page, {
    ...(filter !== undefined ? { filter } : {}),
    after: q.get("after"),
  });
  if (!result.ok) return reply(result, STATUS[result.code]);
  return NextResponse.json({ view: result.view });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let input: { plugin?: unknown; page?: unknown; action?: unknown; key?: unknown };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const result = await actOnPluginPage(
    getRunner(),
    await actorOf(member),
    member.siteId,
    String(input.plugin ?? ""),
    String(input.page ?? ""),
    String(input.action ?? ""),
    String(input.key ?? ""),
  );
  if (!result.ok) return reply(result, STATUS[result.code]);
  return NextResponse.json({ ok: true });
}
