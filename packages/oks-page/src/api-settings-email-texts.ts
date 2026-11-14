// /api/admin/settings/email-texts (spec 13, section 6): the words of the site's emails.
//   GET     every email with its original and current text
//   PUT     { key, subject, body } saves a changed text (checked: required placeholders, https links)
//   DELETE  ?key=… resets one to the original
//   POST    { action: "preview" | "test", key, subject, body }: the email with sample values; "test" also sends it to you
// Only people who manage the settings.
import {
  emailTextFor,
  emailWorks,
  listEmailTexts,
  loadGeneralSettings,
  previewEmailText,
  queueEmail,
  resetEmailText,
  saveEmailText,
} from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { kickEmailJobs, siteSecrets } from "./mail";

const STATUS = { forbidden: 403, invalid: 400 } as const;

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const result = await listEmailTexts(getRunner(), await actorOf(member), member.siteId);
  if (!result.ok) return reply(result, STATUS[result.code]);
  return NextResponse.json({ texts: result.texts });
}

export async function PUT(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const body = await readBody(request);
  if (!body) return reply({ code: "invalid", message: "The request was not understood." }, 400);
  const result = await saveEmailText(
    getRunner(),
    await actorOf(member),
    member.siteId,
    String(body["key"] ?? ""),
    { subject: body["subject"], body: body["body"] },
  );
  if (!result.ok) return reply(result, STATUS[result.code]);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const key = new URL(request.url).searchParams.get("key") ?? "";
  const result = await resetEmailText(getRunner(), await actorOf(member), member.siteId, key);
  if (!result.ok) return reply(result, STATUS[result.code]);
  return NextResponse.json({ ok: true });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const actor = await actorOf(member);
  if (!actor.can("settings.manage"))
    return reply({ code: "forbidden", message: "You may not change the site settings." }, 403);
  const body = await readBody(request);
  if (!body) return reply({ code: "invalid", message: "The request was not understood." }, 400);
  const runner = getRunner();
  const key = String(body["key"] ?? "");
  const subject = typeof body["subject"] === "string" ? body["subject"] : "";
  const text = typeof body["body"] === "string" ? body["body"] : "";
  const siteName = (await loadGeneralSettings(runner, member.siteId)).siteName;
  const footer = (await emailTextFor(runner, member.siteId, "footer")).footer;
  const preview = previewEmailText(key, subject, text, footer, siteName);
  if (body["action"] === "preview") return NextResponse.json({ preview });
  if (body["action"] !== "test")
    return reply({ code: "invalid", message: "Say what to do: preview or test." }, 400);
  if (preview.problems.length > 0)
    return reply({ code: "invalid", message: preview.problems.join(" ") }, 400);
  if (!(await emailWorks(runner, member.siteId)))
    return reply({ code: "invalid", message: "Email is not set up, so no test can be sent." }, 400);
  const queued = await queueEmail(runner, member.siteId, siteSecrets(), {
    key: "test",
    to: member.user.email,
    subject: `Test: ${preview.subject}`,
    text: preview.text,
    html: preview.html,
  });
  if (!queued.queued) return reply({ code: "invalid", message: queued.reason }, 400);
  kickEmailJobs();
  return NextResponse.json({ ok: true, to: member.user.email });
}
