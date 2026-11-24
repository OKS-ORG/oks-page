// /api/privacy/consent (spec 18, section 2). GET says whether the site needs a consent notice and what it asks about; POST
// keeps what a visitor chose, as proof that they were asked (a time, the accepted purposes and the notice version, nothing
// that points to a person). Open to everyone, so a visitor may only send a few choices an hour.
import { NextResponse } from "next/server";
import { isSameOrigin } from "./api-entries";
import { consentInfoOf, recordConsent } from "./consent-record";
import { loadConsentNeeds } from "./consent-needs";
import { getRunner, getSiteId } from "./db";
import { tooOften } from "./visitor-limit";

const base = { "x-content-type-options": "nosniff" };

export async function GET() {
  let siteId: string;
  try {
    siteId = await getSiteId();
  } catch {
    return NextResponse.json({ needed: false, purposes: [], version: "" }, { headers: base });
  }
  const info = consentInfoOf(await loadConsentNeeds(getRunner(), siteId));
  // A minute at most: a page that was opened a moment ago may not know about a plugin that was just switched on.
  return NextResponse.json(info, { headers: { ...base, "cache-control": "public, max-age=60" } });
}

export async function POST(request: Request) {
  const headers = { ...base, "cache-control": "private, no-store" };
  if (!isSameOrigin(request))
    return NextResponse.json(
      { message: "This request came from another address." },
      { status: 403, headers },
    );
  const who = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (tooOften(`consent\n${who}`, 20, 60 * 60 * 1000))
    return NextResponse.json({ message: "Too many requests." }, { status: 429, headers });
  let input: { accepted?: unknown; version?: unknown };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return NextResponse.json(
      { message: "The request was not understood." },
      { status: 400, headers },
    );
  }
  let siteId: string;
  try {
    siteId = await getSiteId();
  } catch {
    return NextResponse.json({ message: "This site is not set up yet." }, { status: 404, headers });
  }
  const result = await recordConsent(getRunner(), siteId, input);
  if (!result.ok) return NextResponse.json({ message: result.message }, { status: 400, headers });
  return NextResponse.json({ ok: true }, { headers });
}
