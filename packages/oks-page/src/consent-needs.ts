// What on the site needs a visitor's consent first (spec 18, section 2): the cookies and outside addresses the switched-on
// plugins declare, and videos set to "load at once" in published pages. Read by Settings > Privacy and the privacy page
// draft. It only reads; nothing is changed.
import type { SqlRunner } from "@oks-page/db";
import {
  readCookies,
  readOutsideHosts,
  type PluginCookie,
  type PluginOutsideHost,
} from "@oks-page/sandbox";

/** What one plugin declares. */
export interface PluginConsent {
  plugin: string;
  cookies: PluginCookie[];
  outsideHosts: PluginOutsideHost[];
}

/** A video that loads from another company the moment its page opens. */
export interface LoadAtOnceVideo {
  entryId: string;
  title: string;
  company: string;
}

export interface ConsentNeeds {
  /** Switched-on plugins that declare cookies or outside addresses. */
  plugins: PluginConsent[];
  videos: LoadAtOnceVideo[];
  /** True when anything above needs consent (`essential` declarations do not). */
  needed: boolean;
}

const parse = (raw: unknown): Record<string, unknown> => {
  try {
    const v = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Every object in a block tree that asks to load at once, with the address it loads. */
function loadNowSources(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) loadNowSources(n, out);
  else if (node !== null && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o["loadNow"] === true && typeof o["src"] === "string") out.push(o["src"]);
    for (const v of Object.values(o))
      if (v !== null && typeof v === "object") loadNowSources(v, out);
  }
  return out;
}

const companyOf = (src: string): string => {
  try {
    return new URL(src).hostname.replace(/^www\./, "");
  } catch {
    return "another company";
  }
};

export async function loadConsentNeeds(runner: SqlRunner, siteId: string): Promise<ConsentNeeds> {
  const plugins: PluginConsent[] = [];
  const rows = await runner.all(
    `select "key", "manifest" from "extensions" where "site_id" = ? and "kind" = 'plugin' and "status" = 'enabled' order by "key"`,
    [siteId],
  );
  for (const r of rows) {
    const m = parse(r["manifest"]);
    const cookies = m["cookies"] === undefined ? [] : readCookies(m["cookies"]);
    const hosts = m["outsideHosts"] === undefined ? [] : readOutsideHosts(m["outsideHosts"]);
    const c = typeof cookies === "string" ? [] : cookies;
    const h = typeof hosts === "string" ? [] : hosts;
    if (c.length > 0 || h.length > 0)
      plugins.push({ plugin: String(r["key"]), cookies: c, outsideHosts: h });
  }
  // The loose text match only picks the candidates (PostgreSQL writes `"loadNow": true`, SQLite `"loadNow":true`).
  const entries = await runner.all(
    `select "id", "title", "body" from "entries" where "site_id" = ? and "status" = 'published' and cast("body" as text) like '%"loadNow"%' order by "title"`,
    [siteId],
  );
  const videos: LoadAtOnceVideo[] = [];
  for (const e of entries)
    for (const src of loadNowSources(parse(e["body"])))
      videos.push({
        entryId: String(e["id"]),
        title: String(e["title"] ?? ""),
        company: companyOf(src),
      });
  const needed =
    videos.length > 0 ||
    plugins.some(
      (p) =>
        p.cookies.some((c) => c.purpose !== "essential") ||
        p.outsideHosts.some((h) => h.purpose !== "essential"),
    );
  return { plugins, videos, needed };
}
