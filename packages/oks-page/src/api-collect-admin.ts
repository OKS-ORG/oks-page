// /api/admin/collect (spec 11, section 8): POST { action } for the agency's side of client content collection:
//   make      { label, note?, days?, maxFiles?, maxMegabytes?, maxText? }  makes a link and shows its address once
//   on, off   { id }                                                         turns a link on or off
//   accept    { id }                                                         puts a file in the library, or text in a new draft page
//   discard   { id }                                                         throws away what a client sent
// Only people who manage the settings.
import {
  acceptCollected,
  createCollectLink,
  discardCollected,
  setCollectLinkOn,
} from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { requestOrigin } from "./auth";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { mediaContext } from "./uploads";

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
  if (typeof input !== "object" || input === null)
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  const actor = await actorOf(member);
  const runner = getRunner();
  const id = typeof input["id"] === "string" ? input["id"] : "";
  switch (input["action"]) {
    case "make": {
      const made = await createCollectLink(runner, actor, member.siteId, input);
      if (!made.ok) return reply(made, STATUS[made.code]);
      const origin = process.env["OKS_SITE_URL"] ?? requestOrigin(request);
      return NextResponse.json({
        ok: true,
        id: made.id,
        link: `${origin.replace(/\/$/, "")}/collect/${made.token}`,
        expiresAt: made.expiresAt,
      });
    }
    case "on":
    case "off": {
      const done = await setCollectLinkOn(
        runner,
        actor,
        member.siteId,
        id,
        input["action"] === "on",
      );
      if (!done.ok) return reply(done, STATUS[done.code]);
      return NextResponse.json({ ok: true });
    }
    case "accept": {
      const done = await acceptCollected(runner, mediaContext(), actor, member.siteId, id);
      if (!done.ok) return reply(done, STATUS[done.code]);
      return NextResponse.json({
        ok: true,
        kind: done.kind,
        entryId: done.entryId,
        mediaId: done.mediaId,
      });
    }
    case "discard": {
      const done = await discardCollected(runner, actor, member.siteId, id);
      if (!done.ok) return reply(done, STATUS[done.code]);
      return NextResponse.json({ ok: true });
    }
    default:
      return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
}
