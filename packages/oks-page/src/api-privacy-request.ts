// POST /api/privacy/request { email, kind, _hp }: a visitor asks to see or delete their personal data (spec 18, section 5). The
// answer is the same whether or not the site keeps anything about the address. The visitor gets an email with a link, and
// nothing is exported or deleted until they open it. Open to everyone, so it is limited: one try at a time, a few an hour
// for each visitor, and one email an hour for each address.
import { loadGeneralSettings } from "@oks-page/core";
import { NextResponse } from "next/server";
import { requestOrigin } from "./auth";
import { isSameOrigin } from "./api-entries";
import { getRunner, getSiteId } from "./db";
import { kickEmailJobs, siteSecrets } from "./mail";
import { createPrivacyRequest } from "./privacy-visitor";
import { queueEmail } from "@oks-page/core";
import { tooOften } from "./visitor-limit";

const HEADERS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
const answer = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: HEADERS });

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return answer(403, { message: "This request came from another address." });
  const who = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (tooOften(`privacy-request\n${who}`, 5, 60 * 60 * 1000))
    return answer(429, { message: "Too many requests. Please try again later." });
  let input: { email?: unknown; kind?: unknown; _hp?: unknown };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return answer(400, { message: "The request was not understood." });
  }
  // A program that fills in the hidden field is told the same as a person, and nothing is done.
  if (typeof input._hp === "string" && input._hp !== "") return answer(200, { ok: true });
  let siteId: string;
  try {
    siteId = await getSiteId();
  } catch {
    return answer(404, { message: "This site is not set up yet." });
  }
  const runner = getRunner();
  const result = await createPrivacyRequest(
    runner,
    siteId,
    { email: input.email, kind: input.kind },
    {
      secrets: siteSecrets(),
      origin: process.env["OKS_SITE_URL"] ?? requestOrigin(request),
      siteName: (await loadGeneralSettings(runner, siteId)).siteName,
      queue: async (to, subject, text, expiresAt) => {
        const queued = await queueEmail(runner, siteId, siteSecrets(), {
          key: "privacy-request",
          to,
          subject,
          text,
          expiresAt,
        });
        if (queued.queued) kickEmailJobs();
        return queued.queued;
      },
    },
  );
  if (!result.ok) return answer(result.code === "invalid" ? 400 : 503, { message: result.message });
  return answer(200, { ok: true });
}
