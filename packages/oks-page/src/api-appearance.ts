// /api/admin/appearance: how the admin looks for the signed-in person (docs/18-new-look.md, step 7).
//   GET     the person's choices (with the site's default under them).
//   PUT     { look?, mode?, accent?, menuCollapsed? } saves what was given and keeps the rest.
//   DELETE  takes the person's own choices away, so the site's default shows again.
// Anyone signed in may change their own; nobody can change another person's.
import { accentAdjusted, loadAppearance, resetAppearance, saveAppearance } from "@oks-page/core";
import { NextResponse } from "next/server";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { siteAppearance } from "./site-appearance";

async function member() {
  return signedInMember({ allowSetup: true });
}

export async function GET() {
  const who = await member();
  if (!who) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const site = await siteAppearance(who.siteId);
  const appearance = await loadAppearance(getRunner(), who.siteId, who.user.id, site);
  return NextResponse.json({
    appearance,
    siteDefault: site,
    adjusted: accentAdjusted(appearance.look, appearance.accent),
  });
}

export async function PUT(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const who = await member();
  if (!who) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const site = await siteAppearance(who.siteId);
  const done = await saveAppearance(getRunner(), who.siteId, who.user.id, input, site);
  if (!done.ok) return reply(done, 400);
  return NextResponse.json({
    ok: true,
    appearance: done.appearance,
    adjusted: accentAdjusted(done.appearance.look, done.appearance.accent),
  });
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const who = await member();
  if (!who) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  await resetAppearance(getRunner(), who.siteId, who.user.id);
  const site = await siteAppearance(who.siteId);
  return NextResponse.json({ ok: true, appearance: site });
}
