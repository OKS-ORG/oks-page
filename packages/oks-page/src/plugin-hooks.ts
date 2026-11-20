// The plugins' hooks in a save (spec 04, sections 5.3 and 7): this connects the core's save to the sandbox host. A site with
// no plugin that is switched on never starts the host, so a site that does not use plugins pays nothing for them.
import type { Actor, HookEntry, SaveHooks } from "@oks-page/core";
import type { SqlRunner } from "@oks-page/db";
import type { ActingUser } from "@oks-page/sandbox";
import { pluginHost } from "./plugin-runtime";

/** True when at least one plugin is switched on. */
async function anyPluginOn(runner: SqlRunner, siteId: string): Promise<boolean> {
  const rows = await runner.all(
    `select "id" from "extensions" where "site_id" = ? and "kind" = 'plugin' and "status" = 'enabled' and "code" is not null limit 1`,
    [siteId],
  );
  return rows.length > 0;
}

/** What the plugins see of an entry: only its plain fields, never its body or other people's data. */
const seen = (entry: HookEntry) => ({
  id: entry.id,
  status: entry.status,
  title: entry.title,
  plainText: entry.plainText.slice(0, 100_000),
  meta: entry.meta,
  typeKey: entry.typeKey,
  authorId: entry.authorId,
});

/**
 * The hooks for one save, or undefined when no plugin is on or the sandbox cannot start (the save then goes on without
 * plugins: fail open). The plugins act for the person who saved: they may do only what both their own permissions and
 * this person's rights allow.
 */
export async function hooksFor(
  runner: SqlRunner,
  siteId: string,
  actor: Actor,
): Promise<SaveHooks | undefined> {
  if (!(await anyPluginOn(runner, siteId))) return undefined;
  let host;
  try {
    host = await pluginHost();
  } catch {
    return undefined;
  }
  const actingFor: ActingUser = { userId: actor.userId, can: (c, t) => actor.can(c, t) };
  return {
    async beforeSave(entry) {
      const run = await host.runFilter("content:beforeSave", seen(entry), { actingFor });
      const out: { title?: string; plugins: Record<string, Record<string, unknown>> } = {
        plugins: {},
      };
      for (const { pluginId, value } of run.applied) {
        const v = value as { title?: unknown; meta?: unknown };
        if (typeof v.title === "string") out.title = v.title;
        // Only what this plugin added or changed in the meta is kept, under its own name.
        if (v.meta !== null && typeof v.meta === "object" && !Array.isArray(v.meta)) {
          const before = entry.meta as Record<string, unknown>;
          const mine: Record<string, unknown> = {};
          for (const [key, val] of Object.entries(v.meta as Record<string, unknown>))
            if (key !== "plugins" && JSON.stringify(val) !== JSON.stringify(before[key]))
              mine[key] = val;
          if (Object.keys(mine).length > 0) out.plugins[pluginId] = mine;
        }
      }
      return out;
    },
    async beforePublish(entry) {
      const check = await host.beforePublish(seen(entry), { actingFor });
      if (!check.allowed)
        return { allowed: false, message: check.refusal?.message ?? "A plugin refused this." };
      return { allowed: true };
    },
    afterSave(entry) {
      // Not waited for: the person who saved gets their answer at once.
      void host.runAction("content:afterSave", seen(entry), { actingFor }).catch(() => undefined);
    },
  };
}
