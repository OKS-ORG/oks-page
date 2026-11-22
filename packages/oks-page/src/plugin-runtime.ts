// The plugin sandbox of this site: one host per process, started when something first needs it (the Plugins screen, an
// install). It loads every enabled plugin from the database (spec 04, section 10). Hooks, blocks and routes use it in
// the next pieces of work; here it only keeps the plugins loaded and tells their state.
import {
  SandboxHost,
  createPluginSettings,
  type ContentEntry,
  type ContentService,
  type PluginSettings,
} from "@oks-page/sandbox";
import type { SqlRunner } from "@oks-page/db";
import path from "node:path";
import { queueEmail } from "@oks-page/core";
import { getRunner, getSiteId } from "./db";
import { kickEmailJobs, siteSecrets } from "./mail";

type Shared = typeof globalThis & { __oksPluginHost?: Promise<SandboxHost> };

const parse = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/** What a plugin may read of an entry. Writing through a plugin comes with the hooks (a later piece of work). */
const content: ContentService = {
  async get(id) {
    const rows = await getRunner().all(
      `select "id", "status", "title", "plain_text", "meta", "author_id", "type_key", "body" from "entries" where "id" = ? and "site_id" = ?`,
      [id, await getSiteId()],
    );
    const r = rows[0];
    if (!r) return null;
    const entry: ContentEntry = {
      id: String(r["id"]),
      status: String(r["status"]),
      title: String(r["title"]),
      plainText: String(r["plain_text"] ?? ""),
      meta: (parse(r["meta"]) as Record<string, unknown> | null) ?? {},
      typeKey: String(r["type_key"]),
      ...(r["author_id"] ? { authorId: String(r["author_id"]) } : {}),
    };
    const body = parse(r["body"]) as { version: number; blocks: unknown[] } | null;
    if (body && Array.isArray(body.blocks)) entry.body = body;
    return entry;
  },
  async update() {
    return null;
  },
};

/** The plugins' saved settings, with secrets sealed by the site's OKS_SECRET (spec 04, section 9; PL-39). */
export function pluginSettingsService(): PluginSettings {
  return createPluginSettings({
    runner: getRunner(),
    siteSecret: process.env["OKS_SECRET"] ?? "",
  });
}

/** Loads one installed plugin into the host (or switches it off there when it is not enabled). */
export async function syncPlugin(
  runner: SqlRunner,
  host: SandboxHost,
  siteId: string,
  extensionId: string,
): Promise<void> {
  const row = (
    await runner.all(
      `select "id", "key", "version", "status", "code", "integrity", "manifest" from "extensions" where "id" = ? and "site_id" = ? and "kind" = 'plugin'`,
      [extensionId, siteId],
    )
  )[0];
  if (!row || typeof row["code"] !== "string") return;
  const manifest = (parse(row["manifest"]) as Record<string, unknown> | null) ?? {};
  const granted = (
    await runner.all(`select "permission" from "extension_permissions" where "extension_id" = ?`, [
      extensionId,
    ])
  ).map((r) => String(r["permission"]));
  host.load(
    {
      id: String(row["key"]),
      version: String(row["version"]),
      permissions: granted,
      ...(typeof manifest["displayName"] === "string"
        ? { displayName: manifest["displayName"] }
        : {}),
      ...(typeof row["integrity"] === "string" ? { integrity: row["integrity"] } : {}),
      ...(manifest["settings"] ? { settings: manifest["settings"] as never } : {}),
      ...(typeof manifest["priority"] === "number" ? { priority: manifest["priority"] } : {}),
      ...(typeof manifest["routes"] === "object" && manifest["routes"]
        ? { routes: manifest["routes"] as never }
        : {}),
      ...(typeof manifest["jobs"] === "object" && manifest["jobs"]
        ? { jobs: manifest["jobs"] as never }
        : {}),
    },
    row["code"],
    extensionId,
  );
  if (row["status"] !== "enabled") host.disable(String(row["key"]));
}

async function start(): Promise<SandboxHost> {
  const runner = getRunner();
  const siteId = await getSiteId();
  const host = new SandboxHost({
    runner,
    siteId,
    content,
    pluginSettings: pluginSettingsService(),
    sendEmail: async (pluginId, mail) => {
      const queued = await queueEmail(runner, siteId, siteSecrets(), {
        key: `plugin-${pluginId}`.slice(0, 60),
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
      });
      if (queued.queued) kickEmailJobs();
      return queued.queued ? { sent: true } : { sent: false, reason: queued.reason };
    },
    workDir: process.env["OKS_PLUGINS_DIR"] ?? path.join(process.cwd(), ".oks", "plugins"),
  });
  await host.listen();
  const rows = await runner.all(
    `select "id" from "extensions" where "site_id" = ? and "kind" = 'plugin' and "code" is not null`,
    [siteId],
  );
  for (const r of rows) await syncPlugin(runner, host, siteId, String(r["id"]));
  return host;
}

/** The site's plugin host, started on first use. A start that failed is tried again on the next use. */
export function pluginHost(): Promise<SandboxHost> {
  const shared = globalThis as Shared;
  if (!shared.__oksPluginHost) {
    shared.__oksPluginHost = start().catch((error: unknown) => {
      delete shared.__oksPluginHost;
      throw error;
    });
  }
  return shared.__oksPluginHost;
}
