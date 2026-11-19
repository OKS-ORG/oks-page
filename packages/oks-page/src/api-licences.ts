// /api/admin/licences: GET the licence keys of the site with what each one allows, POST {key} to add one, DELETE ?id= to
// remove one. Only people who manage the settings (ADR 0037).
import {
  addLicence,
  licenceState,
  listLicences,
  removeLicence,
  type LicencePayload,
  type LicenceState,
} from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { licencePublicKeys } from "./licence-keys";

export interface LicenceRow {
  licence: LicencePayload;
  state: LicenceState;
}

/** What each key allows today, for the first item it covers (or any item, for a key that covers all). */
export function describeLicences(licences: LicencePayload[], host: string): LicenceRow[] {
  const now = new Date();
  return licences.map((licence) => ({
    licence,
    state: licenceState(licence, { item: licence.covers[0] ?? "*", host, now }),
  }));
}

const hostOf = (request: Request): string => {
  try {
    return new URL(request.url).hostname;
  } catch {
    return "";
  }
};

export async function GET(request: Request) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  if (!(await actorOf(member)).can("settings.manage"))
    return reply({ code: "forbidden", message: "You may not see the licence keys." }, 403);
  const licences = await listLicences(getRunner(), member.siteId, licencePublicKeys());
  return NextResponse.json({ keys: describeLicences(licences, hostOf(request)) });
}

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
  const result = await addLicence(
    getRunner(),
    await actorOf(member),
    member.siteId,
    input["key"],
    licencePublicKeys(),
  );
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  return NextResponse.json({
    ok: true,
    key: describeLicences([result.licence], hostOf(request))[0],
  });
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const result = await removeLicence(
    getRunner(),
    await actorOf(member),
    member.siteId,
    id,
    licencePublicKeys(),
  );
  if (!result.ok)
    return reply(
      result,
      result.code === "forbidden" ? 403 : result.code === "not-found" ? 404 : 400,
    );
  return NextResponse.json({ ok: true });
}
