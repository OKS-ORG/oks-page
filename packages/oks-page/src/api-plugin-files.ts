// /api/admin/plugin-files/<id>: a file a visitor sent to a plugin, for a signed-in person who may manage plugins. It is
// always a download (never shown in the page), with the type read from its bytes when it was received, and never cached.
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { reply } from "./api-entries";
import { getRunner } from "./db";
import { openPluginFile } from "./plugin-files";
import { newId } from "@oks-page/db";

const STATUS = { forbidden: 403, not_found: 404 } as const;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const found = await openPluginFile(getRunner(), await actorOf(member), member.siteId, id);
  if (!found.ok) return reply(found, STATUS[found.code]);
  // Who opened which file is written down (names of the plugin and the file's id, never its content).
  await getRunner().all(
    `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id", "detail", "created_at") values (?, ?, 'user', ?, 'plugin.file_opened', 'plugin', ?, ?, ?)`,
    [
      newId(),
      member.siteId,
      member.user.id,
      found.plugin,
      JSON.stringify({ file: id }),
      new Date(),
    ],
  );
  const asciiName = found.name.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(new Uint8Array(found.bytes), {
    headers: {
      "content-type": found.mime,
      "content-length": String(found.bytes.length),
      "content-disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(found.name)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
