// /api/admin/backups (spec 14, part 2): POST { action } for the backups of the whole site:
//   make     {}                  makes a backup now and checks it
//   restore  { name, confirm }   puts the whole site back as it was at that backup (a safety backup is made first)
//   delete   { name }            deletes a backup
//   schedule { daily }           turns the daily backup (03:00, site time) on or off
// GET /api/admin/backups/<name> (api-backup-file.ts) downloads one. Only people who manage the settings.
import { deleteBackup, makeBackup, restoreBackup, saveDailyBackupOn } from "@oks-page/core";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { backupContext } from "./backup-context";
import { slugTag } from "./cache-tags";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { refreshArchives, refreshPlugins } from "./refresh-cache";

const STATUS = { forbidden: 403, invalid: 400, not_found: 404 } as const;

export async function POST(request: Request) {
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
  const actor = await actorOf(member);
  const runner = getRunner();
  const ctx = backupContext();
  switch (input["action"]) {
    case "make": {
      const made = await makeBackup(runner, ctx, actor);
      if (!made.ok) return reply(made, STATUS[made.code]);
      return NextResponse.json({ ok: true, backup: made.info });
    }
    case "restore": {
      const done = await restoreBackup(
        runner,
        ctx,
        actor,
        input["name"],
        input["confirm"] === true,
      );
      if (!done.ok) return reply(done, STATUS[done.code]);
      // Every page, menu, the look and the settings are made fresh at once.
      for (const tag of ["settings", "theme", "site", "menus"]) revalidateTag(tag, { expire: 0 });
      refreshPlugins();
      refreshArchives();
      for (const slug of done.slugs) revalidateTag(slugTag(slug), { expire: 0 });
      return NextResponse.json({
        ok: true,
        rows: done.rows,
        files: done.files,
        safetyBackup: done.safetyBackup,
      });
    }
    case "delete": {
      const gone = await deleteBackup(ctx, actor, input["name"]);
      if (!gone.ok) return reply(gone, STATUS[gone.code]);
      return NextResponse.json({ ok: true });
    }
    case "schedule": {
      const done = await saveDailyBackupOn(runner, actor, member.siteId, input["daily"]);
      if (!done.ok) return reply(done, STATUS[done.code]);
      return NextResponse.json({ ok: true, daily: done.daily });
    }
    default:
      return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
}
