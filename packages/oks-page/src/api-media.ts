// /api/admin/media: GET lists the library, POST uploads one file (multipart form, field "file"). Needs a signed-in member.
import { listMedia, uploadMedia, type ListOptions, type MediaErrorCode } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { kickMediaJobs, mediaContext } from "./uploads";

export const MEDIA_STATUS: Record<MediaErrorCode, number> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  in_use: 409,
};

const KINDS = new Set(["image", "pdf", "video", "audio", "other"]);

export async function GET(request: Request) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const q = new URL(request.url).searchParams;
  const options: ListOptions = {};
  const search = q.get("search");
  if (search) options.search = search;
  const kind = q.get("kind");
  if (kind && KINDS.has(kind)) options.kind = kind as NonNullable<ListOptions["kind"]>;
  if (q.get("unused") === "1") options.unused = true;
  if (q.has("limit")) options.limit = Number(q.get("limit")) || 60;
  if (q.has("offset")) options.offset = Number(q.get("offset")) || 0;
  const result = await listMedia(
    getRunner(),
    mediaContext(),
    await actorOf(member),
    member.siteId,
    options,
  );
  if (!result.ok) return reply(result, MEDIA_STATUS[result.code]);
  return NextResponse.json({ items: result.items, total: result.total });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply({ code: "invalid", message: "The upload was not understood." }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File))
    return reply({ code: "invalid", message: "Choose a file to upload." }, 400);
  const folder = form.get("folder");
  const result = await uploadMedia(
    getRunner(),
    mediaContext(),
    await actorOf(member),
    member.siteId,
    {
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      folderId: typeof folder === "string" && folder ? folder : null,
    },
  );
  if (!result.ok) return reply(result, MEDIA_STATUS[result.code]);
  if (result.status === "processing") kickMediaJobs();
  return NextResponse.json(
    { id: result.id, status: result.status, url: result.url, fileName: result.fileName },
    { status: 201 },
  );
}
