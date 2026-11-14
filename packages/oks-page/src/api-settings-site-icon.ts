// /api/admin/settings/site-icon (Settings > General): PUT {"mediaId"} chooses the site icon from the library, or null removes
// it. Only people who manage the settings. Every public page shows the change at once.
import { saveSiteIcon } from "@oks-page/core";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { mediaContext } from "./uploads";

export async function PUT(request: Request) {
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
  const result = await saveSiteIcon(
    getRunner(),
    await actorOf(member),
    member.siteId,
    input["mediaId"],
  );
  if (!result.ok) return reply(result, result.code === "forbidden" ? 403 : 400);
  revalidateTag("settings", { expire: 0 });
  return NextResponse.json({
    ok: true,
    icon: result.icon
      ? { url: mediaContext().storage.publicUrl(result.icon.key), ...result.icon }
      : null,
  });
}
