// POST /api/privacy/confirm { token }: the person opens the link in the confirmation email and confirms their request (spec 18,
// section 5). It is a POST made by a button on the page, so a program that only follows the link (an email scanner) confirms
// nothing. The owner is told by email.
import { queueEmail } from "@oks-page/core";
import { NextResponse } from "next/server";
import { requestOrigin } from "./auth";
import { isSameOrigin } from "./api-entries";
import { getRunner } from "./db";
import { kickEmailJobs, siteSecrets } from "./mail";
import { confirmPrivacyRequest } from "./privacy-visitor";
import { tooOften } from "./visitor-limit";

const HEADERS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
const answer = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: HEADERS });

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return answer(403, { message: "This request came from another address." });
  const who = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (tooOften(`privacy-confirm\n${who}`, 20, 60 * 60 * 1000))
    return answer(429, { message: "Too many tries. Please try again later." });
  let input: { token?: unknown };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return answer(400, { message: "The request was not understood." });
  }
  const runner = getRunner();
  const result = await confirmPrivacyRequest(runner, String(input.token ?? ""), {
    origin: process.env["OKS_SITE_URL"] ?? requestOrigin(request),
    notify: async (siteId, to, subject, text) => {
      const queued = await queueEmail(runner, siteId, siteSecrets(), {
        key: "privacy-request-confirmed",
        to,
        subject,
        text,
      });
      if (queued.queued) kickEmailJobs();
      return queued.queued;
    },
  });
  if (!result.ok)
    return answer(400, {
      message: "This link is not valid any more. If you still want to ask, send a new request.",
    });
  return answer(200, { ok: true, kind: result.kind, already: result.already });
}
