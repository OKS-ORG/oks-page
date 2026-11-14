// /api/admin/themes/<id>/export?name=… — "Export as a theme" (spec 05, section 17.6): downloads a theme package made from
// this theme as the site shows it now (the layout changes, the layouts the owner made, the saved sections and the look),
// which passes the theme checks and installs on another site. Only people who may change the site design.
import { exportTheme } from "@oks-page/core";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { reply } from "./api-entries";
import { LAYOUT_STATUS } from "./api-theme-layouts";
import { getRunner } from "./db";
import { mediaContext } from "./uploads";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const name = new URL(request.url).searchParams.get("name") ?? "";
  const result = await exportTheme(
    getRunner(),
    mediaContext().storage,
    await actorOf(member),
    member.siteId,
    id,
    { name },
  );
  if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
  return new Response(new Uint8Array(result.archive), {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${result.fileName}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
