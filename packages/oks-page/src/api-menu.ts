// /api/admin/menus/[place]: GET a menu with what can be put in it, PUT to save it ("primary" or "footer").
import { loadMenu, loadMenuChoices, saveMenu } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { refreshMenus } from "./refresh-cache";

type Context = { params: Promise<{ place: string }> };

const STATUS = { forbidden: 403, invalid: 400, conflict: 409, not_found: 404 } as const;

export async function GET(_request: Request, context: Context) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  if (!(await actorOf(member)).can("menus.manage"))
    return reply({ code: "forbidden", message: "You may not see the menus." }, 403);
  const { place } = await context.params;
  const runner = getRunner();
  const menu = await loadMenu(runner, member.siteId, place);
  return NextResponse.json({ menu, choices: await loadMenuChoices(runner, member.siteId) });
}

export async function PUT(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { place } = await context.params;
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const result = await saveMenu(getRunner(), await actorOf(member), member.siteId, place, {
    items: input["items"],
    updatedAt: input["updatedAt"],
  });
  if (!result.ok) return reply(result, STATUS[result.code]);
  refreshMenus();
  return NextResponse.json({ ok: true, updatedAt: result.updatedAt });
}
