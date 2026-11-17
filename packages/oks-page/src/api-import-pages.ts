// POST /api/admin/import/pages: import pages or posts from a CSV file (multipart form: "file", and "type" for the kind
// of content a row gets when it names none). The answer is a report, row by row. The core checks every right.
import {
  importPagesFromCsv,
  importPagesFromMarkdown,
  MAX_IMPORT_CHARS,
  type ImportResult,
} from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { refreshEntry } from "./refresh-cache";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const type = String(form.get("type") ?? "page");
  const actor = await actorOf(member);
  const markdown = form.getAll("files").filter((f): f is File => f instanceof File);
  let result: ImportResult;
  if (markdown.length > 0) {
    if (markdown.some((f) => f.size > MAX_IMPORT_CHARS))
      return reply({ code: "invalid", field: "files", message: "A file is too big." }, 400);
    result = await importPagesFromMarkdown(
      getRunner(),
      actor,
      member.siteId,
      await Promise.all(markdown.map(async (f) => ({ name: f.name, text: await f.text() }))),
      type,
    );
  } else {
    const file = form.get("file");
    if (!(file instanceof File))
      return reply({ code: "invalid", field: "file", message: "Choose a file." }, 400);
    if (file.size > MAX_IMPORT_CHARS * 4)
      return reply({ code: "invalid", field: "file", message: "The file is too big." }, 400);
    result = await importPagesFromCsv(getRunner(), actor, member.siteId, await file.text(), type);
  }
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  // Pages that went live show on the public site at once.
  for (const item of result.items)
    if (item.status === "published" && item.id && item.slug) refreshEntry(item.id, item.slug);
  return NextResponse.json(result);
}
