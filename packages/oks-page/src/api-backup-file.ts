// GET /api/admin/backups/<name>: downloads one backup file. It holds all of the site's data, so only people who manage the settings
// may have it, and it is never cached. It is sent as it is read from the disk, not loaded into memory whole.
import { backupPath } from "@oks-page/core";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { backupContext } from "./backup-context";
import { reply } from "./api-entries";

type Context = { params: Promise<{ name: string }> };

export async function GET(_request: Request, context: Context) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  if (!(await actorOf(member)).can("settings.manage"))
    return reply({ code: "forbidden", message: "You may not download backups." }, 403);
  const { name } = await context.params;
  const file = backupPath(backupContext(), name);
  const info = file ? await stat(file).catch(() => null) : null;
  if (!file || !info)
    return reply({ code: "not_found", message: "This backup does not exist." }, 404);
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: {
      "content-type": "application/gzip",
      "content-length": String(info.size),
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
