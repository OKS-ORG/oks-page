export interface PluginManifest {
  /** The plugin's name, for example "reading-time". Unique in a site. */
  id: string;
  displayName?: string;
  version: string;
  /** The permissions the owner approved (spec 04, section 4), for example "content:read" or "network:fetch:api.example.com". */
  permissions: string[];
  /** sha256 of the bundle, set at install; checked on every start (spec 04, PL-23). */
  integrity?: string;
}

export interface ContentEntry {
  id: string;
  status: string;
  title: string;
  plainText?: string;
  meta?: Record<string, unknown>;
}

/** What a plugin may reach inside the site. The core provides it; the sandbox only calls it after the permission check. */
export interface ContentService {
  get(id: string): Promise<ContentEntry | null>;
  /** Only `title` and `meta` can change through a plugin; the host filters the patch before this is called. */
  update(
    id: string,
    patch: Partial<Pick<ContentEntry, "title" | "meta">>,
  ): Promise<ContentEntry | null>;
}

export type CallKind = "hook" | "block";

export type CallResult =
  | { ok: true; result: unknown; skipped?: false; ms: number }
  | { ok: true; skipped: true; result?: undefined; ms: number }
  | {
      ok: false;
      error: string;
      code?: string;
      killed?: boolean;
      skipped?: boolean;
      reason?: string;
      ms: number;
    };

export type PluginStatus = "enabled" | "disabled" | "switched_off";

export interface OwnerNotice {
  pluginId: string;
  message: string;
  at: number;
}
