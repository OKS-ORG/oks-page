// Scripts of interactive blocks, "islands" (spec 04, section 8; PL-42). A plugin ships a small script in its package. The
// site serves it from its own origin, and only for a plugin that is on and has the `site:scripts` permission; the page
// loads it with a checked hash. The site's content security policy allows scripts from the site itself and nothing
// else, so a script that is not served by the site cannot run.
import { createHash } from "node:crypto";

export const SCRIPT_PERMISSION = "site:scripts";
/** Where a plugin's scripts are served. */
export const SCRIPT_PREFIX = "/_oks/plugins/";

const PLUGIN_ID = /^[a-z0-9-]{3,40}$/;
// A script path: lower-case folders and a file ending in .js, with no way to climb out (.. , //, a leading slash).
const SCRIPT_PATH =
  /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*(\/[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*)*\.js$/;

export interface PluginScriptFile {
  /** For example "islands/cart.js". */
  path: string;
  source: string;
}

export interface ScriptResponse {
  status: 200 | 404;
  headers: Record<string, string>;
  body: string;
}

interface Stored {
  source: string;
  /** The sha256 of the source, in the form the page's `integrity` attribute uses. */
  integrity: string;
  /** A short version for the address, so a changed script is a new address. */
  version: string;
}

/** `allowed(pluginId)` says whether the plugin is on and has the permission; the sandbox host provides it. */
export class PluginScripts {
  private readonly files = new Map<string, Map<string, Stored>>();

  constructor(private readonly allowed: (pluginId: string) => boolean) {}

  /** Keeps a plugin's scripts. A path that could reach outside the plugin's own folder is refused. */
  add(pluginId: string, files: PluginScriptFile[]): void {
    if (!PLUGIN_ID.test(pluginId)) throw new Error(`"${pluginId}" is not a valid plugin id`);
    const mine = new Map<string, Stored>();
    for (const file of files) {
      if (!SCRIPT_PATH.test(file.path) || file.path.length > 120)
        throw new Error(`"${file.path}" is not an allowed script path`);
      const digest = createHash("sha256").update(file.source);
      const hash = digest.digest();
      mine.set(file.path, {
        source: file.source,
        integrity: `sha256-${hash.toString("base64")}`,
        version: hash.toString("hex").slice(0, 16),
      });
    }
    this.files.set(pluginId, mine);
  }

  /** The address of one script, with its version. */
  url(pluginId: string, path: string): string | null {
    const stored = this.files.get(pluginId)?.get(path);
    return stored ? `${SCRIPT_PREFIX}${pluginId}/${path}?v=${stored.version}` : null;
  }

  /** The `<script>` tags for the plugins on a page. A plugin that is off, or has no permission, adds none. */
  tags(pluginIds: string[]): string[] {
    const tags: string[] = [];
    for (const id of pluginIds) {
      if (!this.allowed(id)) continue;
      for (const [path, s] of this.files.get(id) ?? [])
        tags.push(
          `<script type="module" src="${this.url(id, path)}" integrity="${s.integrity}" crossorigin="anonymous"></script>`,
        );
    }
    return tags;
  }

  /** Answers a request for \`/_oks/plugins/<id>/<path>?v=...\`. Anything that is not exactly a script of a plugin that is
   * allowed gets the same plain 404, so nothing tells a visitor which plugins are installed. */
  serve(requestUrl: string): ScriptResponse {
    const notFound: ScriptResponse = {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
      body: "Not found",
    };
    if (!requestUrl.startsWith(SCRIPT_PREFIX)) return notFound;
    const [pathPart = "", query = ""] = requestUrl.slice(SCRIPT_PREFIX.length).split("?", 2);
    const slash = pathPart.indexOf("/");
    if (slash < 1) return notFound;
    const pluginId = pathPart.slice(0, slash);
    const path = pathPart.slice(slash + 1);
    // The path is matched as it is, never decoded: "%2e%2e" is not ".." here, it is simply not a script.
    if (!PLUGIN_ID.test(pluginId) || !SCRIPT_PATH.test(path) || !this.allowed(pluginId))
      return notFound;
    const stored = this.files.get(pluginId)?.get(path);
    if (!stored) return notFound;
    const version = new URLSearchParams(query).get("v");
    return {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "x-content-type-options": "nosniff",
        // The address carries the version, so a script at its current address never changes.
        "cache-control":
          version === stored.version ? "public, max-age=31536000, immutable" : "no-cache",
      },
      body: stored.source,
    };
  }
}

/** The content security policy for public pages: scripts and everything else only from the site itself, no inline
 * script or style, no `eval`, no plugins, no other base address, and no framing by other sites. Theme CSS and fonts come
 * from the site's own address (spec 05, sections 6 and 8), so nothing else is needed. */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
