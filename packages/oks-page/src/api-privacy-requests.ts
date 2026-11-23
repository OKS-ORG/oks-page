// /api/admin/privacy-requests (Tools > Privacy requests): POST { action: "find" | "export" | "delete", email }. The address is
// in the body, never in the address of the request, so it does not land in a log. "find" answers with what the site keeps for
// the address, "export" with a ZIP file, "delete" with how much was removed. Only people who manage the site's settings.
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { deletePersonalData, exportPersonalData, findPersonalData } from "./privacy-requests";
import { answerPrivacyRequest, listPrivacyRequests } from "./privacy-visitor";
import { siteSecrets } from "./mail";

const STATUS = { forbidden: 403, invalid: 400, not_found: 404 } as const;

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let input: { action?: unknown; email?: unknown };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const actor = await actorOf(member);
  const email = String(input.email ?? "");
  if (input.action === "requests") {
    const r = await listPrivacyRequests(getRunner(), actor, member.siteId, siteSecrets());
    if (!r.ok) return reply(r, STATUS[r.code]);
    return NextResponse.json(
      { waiting: r.waiting, open: r.open, answered: r.answered },
      { headers: { "cache-control": "no-store" } },
    );
  }
  if (input.action === "answer") {
    const r = await answerPrivacyRequest(
      getRunner(),
      actor,
      member.siteId,
      String((input as { id?: unknown }).id ?? ""),
    );
    if (!r.ok) return reply(r, STATUS[r.code]);
    return NextResponse.json({ ok: true });
  }
  if (input.action === "find") {
    const r = await findPersonalData(getRunner(), actor, member.siteId, email);
    if (!r.ok) return reply(r, STATUS[r.code]);
    return NextResponse.json({ result: r.result }, { headers: { "cache-control": "no-store" } });
  }
  if (input.action === "export") {
    const r = await exportPersonalData(getRunner(), actor, member.siteId, email);
    if (!r.ok) return reply(r, STATUS[r.code]);
    return new Response(new Uint8Array(r.zip), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${r.filename}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-oks-items": String(r.items),
        "x-oks-files": String(r.files),
      },
    });
  }
  if (input.action === "delete") {
    const r = await deletePersonalData(getRunner(), actor, member.siteId, email);
    if (!r.ok) return reply(r, STATUS[r.code]);
    return NextResponse.json(
      { items: r.items, files: r.files, emails: r.emails, account: r.account },
      { headers: { "cache-control": "no-store" } },
    );
  }
  return reply({ code: "invalid", message: "The request was not understood." }, 400);
}
