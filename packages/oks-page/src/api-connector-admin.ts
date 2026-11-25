// /api/admin/connector (spec 11, section 6): POST { action: "make" } makes a connection key and shows its connection code once;
// POST { action: "remove", id } removes a key. For people who manage the settings.
import { addConnectorKey, removeConnectorKey } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { requestOrigin } from "./auth";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { siteSecrets } from "./mail";

const STATUS = { forbidden: 403, invalid: 400, not_found: 404 } as const;

export async function POST(request: Request) {
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
  const actor = await actorOf(member);
  const runner = getRunner();
  if (input["action"] === "make") {
    const origin = (process.env["OKS_SITE_URL"] ?? requestOrigin(request)).replace(/\/$/, "");
    const made = await addConnectorKey(runner, actor, member.siteId, siteSecrets(), origin);
    if (!made.ok) return reply(made, STATUS[made.code]);
    return NextResponse.json({ ok: true, id: made.id, code: made.code });
  }
  if (input["action"] === "remove" && typeof input["id"] === "string") {
    const done = await removeConnectorKey(runner, actor, member.siteId, input["id"]);
    if (!done.ok) return reply(done, STATUS[done.code]);
    return NextResponse.json({ ok: true });
  }
  return reply({ code: "invalid", message: "The request was not understood." }, 400);
}
