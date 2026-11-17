// /api/admin/fonts: GET lists the fonts this site keeps, POST adds one (multipart form: "file", "name", "kind",
// "weight" and "licence"). Only people who manage the settings. The file is checked before it is kept.
import { addOwnerFont, loadOwnerFonts, MAX_OWNER_FONT_BYTES } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";

const STATUS = { forbidden: 403, invalid: 400, not_found: 404, in_use: 409 } as const;

export async function GET() {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  if (!(await actorOf(member)).can("settings.manage"))
    return reply({ code: "forbidden", message: "You may not see the design." }, 403);
  return NextResponse.json({ fonts: await loadOwnerFonts(getRunner(), member.siteId) });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const actor = await actorOf(member);
  if (!actor.can("settings.manage"))
    return reply({ code: "forbidden", message: "You may not change the design." }, 403);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File))
    return reply({ code: "invalid", field: "file", message: "Choose a font file." }, 400);
  if (file.size > MAX_OWNER_FONT_BYTES)
    return reply(
      {
        code: "invalid",
        field: "file",
        message: `The file is too big. A font file can be at most ${Math.round(MAX_OWNER_FONT_BYTES / 1000)} KB.`,
      },
      400,
    );
  const text = (name: string) => String(form.get(name) ?? "");
  const result = await addOwnerFont(getRunner(), actor, member.siteId, {
    name: text("name"),
    kind: text("kind"),
    weight: text("weight"),
    licence: text("licence") === "true",
    bytes: new Uint8Array(await file.arrayBuffer()),
  });
  if (!result.ok) return reply(result, STATUS[result.code]);
  return NextResponse.json({ ok: true, font: result.font }, { status: 201 });
}
