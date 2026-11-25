// POST /api/collect/<token> (spec 11, section 8): what a client sends through a guided link: a name, some text and files, as a
// form. Open to everyone who holds the link, so it is limited: at most 10 tries a minute for each link, and a few more for
// each visitor. A wrong, turned-off or expired link gets a plain message. Nothing is published; it all waits in the inbox.
import { openCollectLink, submitCollected } from "@oks-page/core";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { isSameOrigin } from "./api-entries";
import { getRunner } from "./db";
import { tooOften } from "./visitor-limit";

const HEADERS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
const answer = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: HEADERS });

type Context = { params: Promise<{ token: string }> };

export async function POST(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return answer(403, { message: "This request came from another address." });
  const { token } = await context.params;
  const who = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  // Ten tries a minute for the link (whoever sends), and sixty for one visitor over all links.
  const key = createHash("sha256").update(token).digest("hex");
  if (tooOften(`collect-link\n${key}`, 10, 60_000) || tooOften(`collect-who\n${who}`, 60, 60_000))
    return answer(429, { message: "Too many tries. Please wait a minute and try again." });
  const runner = getRunner();
  const opened = await openCollectLink(runner, token);
  if (!opened.ok)
    return answer(opened.reason === "unknown" ? 404 : 410, { message: opened.message });
  // A body far bigger than what is left is refused before it is read.
  const left = Math.max(0, opened.link.maxBytes - opened.link.usedBytes);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > left + 2 * 1024 * 1024)
    return answer(413, { message: "The files are too big for this link." });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return answer(400, { message: "The request was not understood." });
  }
  // A program that fills in the hidden field is told the same as a person, and nothing is kept.
  const trap = form.get("_hp");
  if (typeof trap === "string" && trap !== "") return answer(200, { ok: true, texts: 0, files: 0 });
  const files: { name: string; bytes: Uint8Array }[] = [];
  for (const entry of form.getAll("files")) {
    if (typeof entry === "string") continue;
    if (entry.size === 0 && entry.name === "") continue;
    files.push({ name: entry.name, bytes: new Uint8Array(await entry.arrayBuffer()) });
  }
  const sender = form.get("sender");
  const text = form.get("text");
  const result = await submitCollected(runner, token, {
    sender: typeof sender === "string" ? sender : "",
    text: typeof text === "string" ? text : "",
    files,
  });
  if (!result.ok) return answer(result.code === "closed" ? 410 : 400, { message: result.message });
  return answer(200, { ok: true, texts: result.texts, files: result.files });
}
