// /api/admin/bundle (spec 11, section 9): GET downloads the site bundle (the site's pages, media, menus and look in one
// file); POST?confirm=replace uploads a bundle and puts it on this site in place of what the bundle holds. Only people who
// may export and import, and who manage the settings.
import { exportBundle, importBundle } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { revalidateTag } from "next/cache";
import { slugTag } from "./cache-tags";
import { refreshArchives, refreshPlugins } from "./refresh-cache";
import { mediaContext } from "./uploads";

/** The largest bundle file taken in one upload. */
const ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;

const STATUS = { forbidden: 403, invalid: 400 } as const;

export async function GET() {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const result = await exportBundle(
    getRunner(),
    mediaContext().storage,
    await actorOf(member),
    member.siteId,
  );
  if (!result.ok) return reply(result, STATUS[result.code]);
  return new Response(new Uint8Array(result.archive), {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${result.fileName}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // What the bundle holds and what was left out, for the screen that asked.
      "x-bundle-counts": JSON.stringify(result.counts),
      "x-bundle-skipped": encodeURIComponent(JSON.stringify(result.skipped)),
    },
  });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > ARCHIVE_MAX_BYTES)
    return reply({ code: "invalid", message: "The bundle is too large to upload." }, 413);
  const archive = Buffer.from(await request.arrayBuffer());
  if (archive.length > ARCHIVE_MAX_BYTES)
    return reply({ code: "invalid", message: "The bundle is too large to upload." }, 413);
  const replace = new URL(request.url).searchParams.get("confirm") === "replace";
  const result = await importBundle(
    getRunner(),
    mediaContext().storage,
    await actorOf(member),
    member.siteId,
    archive,
    { replace },
  );
  if (!result.ok) return reply(result, STATUS[result.code]);
  // Every public page, menu, the look and the settings are made fresh at once.
  for (const tag of ["settings", "theme", "site", "menus"]) revalidateTag(tag, { expire: 0 });
  refreshPlugins();
  refreshArchives();
  for (const slug of result.slugs) revalidateTag(slugTag(slug), { expire: 0 });
  return NextResponse.json({
    ok: true,
    counts: result.counts,
    siteName: result.siteName,
    skippedThemes: result.skippedThemes,
  });
}
