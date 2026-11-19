// POST /api/comments: a visitor's comment on a published post. The comment waits until someone approves it.
// A plain form (no script needed) or JSON. A hidden field a person never fills in catches simple spam robots, and each
// visitor address may send only a few comments an hour (counted in memory only: nothing about the visitor is stored).
import { addComment } from "@oks-page/core";
import { NextResponse } from "next/server";
import { isSameOrigin } from "./api-entries";
import { getRunner, getSiteId } from "./db";

const LIMIT = 5;
const HOUR = 60 * 60 * 1000;
const seen = new Map<string, number[]>();

/** True when this visitor has sent too many comments in the last hour; counts this try when it is allowed. */
export function tooMany(key: string, now = Date.now()): boolean {
  const recent = (seen.get(key) ?? []).filter((t) => now - t < HOUR);
  if (recent.length >= LIMIT) {
    seen.set(key, recent);
    return true;
  }
  recent.push(now);
  seen.set(key, recent);
  // The table never grows without bound: a visitor with nothing recent is forgotten.
  if (seen.size > 5000)
    for (const [k, v] of seen) if (v.every((t) => now - t >= HOUR)) seen.delete(k);
  return false;
}

const page = (title: string, text: string, back: string, status: number) =>
  new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body><main style="max-inline-size:40rem;margin:3rem auto;padding:0 1rem;font-family:system-ui,sans-serif"><h1>${title}</h1><p>${text}</p><p><a href="${back}">Back to the post</a></p></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

const safeBack = (value: unknown): string =>
  typeof value === "string" &&
  /^\/[\p{L}\p{N}\p{M}\-._~/%]*$/u.test(value) &&
  !value.startsWith("//")
    ? `${value}#comments`
    : "/";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return NextResponse.json(
      { error: { message: "This request came from another address." } },
      { status: 403 },
    );
  const json = (request.headers.get("content-type") ?? "").includes("application/json");
  let input: Record<string, unknown>;
  try {
    input = json
      ? ((await request.json()) as Record<string, unknown>)
      : Object.fromEntries((await request.formData()).entries());
  } catch {
    return json
      ? NextResponse.json(
          { error: { message: "The request was not understood." } },
          { status: 400 },
        )
      : page("Not sent", "The request was not understood.", "/", 400);
  }
  const back = safeBack(input["back"]);
  const thanks = () =>
    json
      ? NextResponse.json({ ok: true })
      : page(
          "Thank you",
          "Your comment is saved. It shows on the post after someone has looked at it.",
          back,
          200,
        );
  // The hidden field: a robot fills it, a person never sees it. It gets the same answer as a real comment.
  if (typeof input["website"] === "string" && input["website"] !== "") return thanks();
  const who = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (tooMany(who))
    return json
      ? NextResponse.json(
          { error: { message: "Too many comments. Try again later." } },
          { status: 429 },
        )
      : page(
          "Too many comments",
          "You sent several comments in a short time. Try again later.",
          back,
          429,
        );
  const result = await addComment(getRunner(), await getSiteId(), {
    entryId: String(input["entryId"] ?? ""),
    name: input["name"],
    content: input["content"],
  });
  if (!result.ok)
    return json
      ? NextResponse.json(
          { error: { message: result.message, field: result.field } },
          { status: 400 },
        )
      : page("Not sent", result.message, back, 400);
  return thanks();
}
