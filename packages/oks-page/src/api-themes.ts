// /api/admin/themes: GET lists the installed themes, POST uploads a theme file (multipart form, field "file"), checks it
// and stores it. A new theme is not used until the owner says so; a new version of the theme in use is used at once.
// Only people who may change the design (`themes.manage`).
import { installTheme, listThemes, THEME_UPLOAD_MAX_BYTES } from "@oks-page/core";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { mediaContext } from "./uploads";

export async function GET() {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  if (!(await actorOf(member)).can("themes.manage"))
    return reply({ code: "forbidden", message: "You may not change the design." }, 403);
  return NextResponse.json({ themes: await listThemes(getRunner(), member.siteId) });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const actor = await actorOf(member);
  if (!actor.can("themes.manage"))
    return reply({ code: "forbidden", message: "You may not change the design." }, 403);
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > THEME_UPLOAD_MAX_BYTES + 64 * 1024)
    return reply(
      { code: "invalid", message: "This file is too large for a theme (24 MB at most)." },
      400,
    );
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply({ code: "invalid", message: "The upload was not understood." }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File))
    return reply({ code: "invalid", message: "Choose a theme file to upload." }, 400);
  if (file.size > THEME_UPLOAD_MAX_BYTES)
    return reply(
      { code: "invalid", message: "This file is too large for a theme (24 MB at most)." },
      400,
    );
  const result = await installTheme(
    getRunner(),
    mediaContext().storage,
    actor,
    member.siteId,
    Buffer.from(await file.arrayBuffer()),
  );
  if (!result.ok)
    return NextResponse.json(
      { error: { code: result.code, message: result.message }, report: result.report ?? null },
      { status: result.code === "forbidden" ? 403 : 400 },
    );
  // A new version of the theme in use changes every public page.
  if (result.theme.isActive && result.change === "update") revalidateTag("theme", { expire: 0 });
  return NextResponse.json({
    ok: true,
    change: result.change,
    theme: result.theme,
    report: result.report,
  });
}
