// /api/admin/settings/branding (spec 11, section 5): PUT { name, logoId, helpUrl, footer } saves the white-label settings. The
// name is free; the logo, the help link and the footer line need an Agency licence key. Only people who manage the settings.
import { agencyActive, listLicences, saveWhiteLabel } from "@oks-page/core";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { licencePublicKeys } from "./licence-keys";

export async function PUT(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const host = ((await headers()).get("host") ?? "").replace(/:\d+$/, "");
  const agency = agencyActive(
    await listLicences(getRunner(), member.siteId, licencePublicKeys()),
    host,
    new Date(),
  );
  const result = await saveWhiteLabel(
    getRunner(),
    await actorOf(member),
    member.siteId,
    input,
    agency,
  );
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  return NextResponse.json({ ok: true, whiteLabel: result.whiteLabel });
}
