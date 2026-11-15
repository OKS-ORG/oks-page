// /api/admin/themes/<id>: GET says what using the theme would keep, move and leave behind (nothing changes),
// POST { action: "use" } uses the theme ("default" as the id goes back to the built-in design),
// POST { action: "roll-back" } goes back to the version before, DELETE removes a theme that is not in use.
// Only people who may change the design (`themes.manage`).
import { planThemeSwitch, removeTheme, rollBackTheme, useTheme } from "@oks-page/core";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { mediaContext } from "./uploads";

type Context = { params: Promise<{ id: string }> };
const STATUS = { forbidden: 403, invalid: 400, not_found: 404 } as const;

export async function GET(_request: Request, context: Context) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const result = await planThemeSwitch(
    getRunner(),
    await actorOf(member),
    member.siteId,
    id === "default" ? null : id,
  );
  if (!result.ok) return reply(result, STATUS[result.code]);
  return NextResponse.json({ plan: result.plan });
}

export async function POST(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  let input: { action?: unknown };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const actor = await actorOf(member);
  if (input.action === "use") {
    const result = await useTheme(getRunner(), actor, member.siteId, id === "default" ? null : id);
    if (!result.ok) return reply(result, STATUS[result.code]);
    // Every public page carries the theme, so all of them are written again at the next request.
    revalidateTag("theme", { expire: 0 });
    return NextResponse.json({ ok: true, active: result.active });
  }
  if (input.action === "roll-back") {
    const result = await rollBackTheme(getRunner(), actor, member.siteId, id);
    if (!result.ok) return reply(result, STATUS[result.code]);
    if (result.theme.isActive) revalidateTag("theme", { expire: 0 });
    return NextResponse.json({ ok: true, theme: result.theme });
  }
  return reply({ code: "invalid", message: "Say what to do: use or roll-back." }, 400);
}

export async function DELETE(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const result = await removeTheme(
    getRunner(),
    mediaContext().storage,
    await actorOf(member),
    member.siteId,
    id,
  );
  if (!result.ok) return reply(result, STATUS[result.code]);
  return NextResponse.json({ ok: true });
}
