export interface PluginManifest {
  /** The plugin's name, for example "reading-time". Unique in a site. */
  id: string;
  displayName?: string;
  version: string;
  /** The permissions the owner approved (spec 04, section 4), for example "content:read" or "network:fetch:api.example.com". */
  permissions: string[];
  /** sha256 of the bundle, set at install; checked on every start (spec 04, PL-23). */
  integrity?: string;
  /** The settings the owner fills in (spec 04, section 9). */
  settings?: SettingsSchema;
  /** Filters run by priority, lowest first, then in install order (spec 04, section 7). Default 10. */
  priority?: number;
  /** The web addresses the plugin adds under `/api/oks/plugins/<id>/<name>` (needs `routes:public`; spec 04, section 9). */
  routes?: Record<string, RouteInfo>;
}

/** What a plugin says about one of its routes. The site checks it before the plugin's code is called. */
export interface RouteInfo {
  method: "GET" | "POST";
  /** The most bytes of the request body the site hands to the plugin. Default 20 000, at most 100 000. */
  maxBytes?: number;
  /** Only a signed-in person may use the route (the plugin then also gets who it is). */
  signedIn?: boolean;
}

/** What the site hands to a plugin's route. Nothing in it names the visitor beyond what they sent. */
export interface RouteRequest {
  method: "GET" | "POST";
  /** The query string as text pairs (the first value of each name, at most 50). */
  query: Record<string, string>;
  /** The body as text (cut at the route's limit: a bigger request never reaches the plugin). */
  body: string;
  /** The body read as data: JSON, or a form (`application/x-www-form-urlencoded`), else null. */
  data: Record<string, unknown> | null;
  /** The request's content type, without parameters. */
  contentType: string;
  /** Who is signed in, for a route that needs it. */
  user?: { id: string };
}

/** What a plugin's route answers; the site turns it into a web answer. */
export interface RouteReply {
  /** 200 to 599, but not a redirect: use `redirect`. Default 200. */
  status: number;
  /** Exactly one of these is set. */
  json?: unknown;
  text?: string;
  /** A path on this site (starts with one slash): answered with a 303 so a form sent by a browser lands there. */
  redirect?: string;
}

export type RouteRun =
  { ok: true; reply: RouteReply } | { ok: false; status: number; message: string };

/** One setting a plugin declares. A `secret` (an API key) is sealed at rest and never shown in full again (PL-39). */
export interface SettingField {
  type: "text" | "number" | "boolean" | "secret";
  label?: string;
}

export type SettingsSchema = Record<string, SettingField>;

export interface ContentEntry {
  id: string;
  status: string;
  title: string;
  plainText?: string;
  meta?: Record<string, unknown>;
  /** Who wrote the entry. Needed to tell "own" from "any" when a plugin acts for a person (PL-38). */
  authorId?: string;
  /** The content type, for roles that are limited to some types (spec 02, section 6). */
  typeKey?: string;
  /** The block tree (spec 03). Reaches this interface only after the host has run it through the block checks (PL-37). */
  body?: { version: number; blocks: unknown[] };
}

/** What a plugin may reach inside the site. The core provides it; the sandbox only calls it after the permission check. */
export interface ContentService {
  get(id: string): Promise<ContentEntry | null>;
  /** Only `title`, `meta` and `body` can change through a plugin; the host filters the patch before this is called,
   * and `body` has already passed the block checks (PL-37) by the time it arrives here. */
  update(
    id: string,
    patch: Partial<Pick<ContentEntry, "title" | "meta" | "body">>,
  ): Promise<ContentEntry | null>;
}

export type CallKind = "hook" | "block" | "route";

/** The person a call acts for (spec 02, section 8, rule 1). The core builds it from the person's role, for example
 * with `capabilitiesOf` from `@oks-page/auth`. */
export interface ActingUser {
  userId: string;
  can(capability: string, typeKey?: string): boolean;
}

export interface CallOptions {
  /** A time limit for this call instead of the host's usual one (spec 04, section 5.3: publish hooks get 5 seconds). */
  timeoutMs?: number;
  /** Set when a person's action started the call (they saved a post): the plugin may then do only what both its own
   * permissions and this person's capabilities allow. Not set for a job or a hook with no person: then only the
   * plugin's permissions apply. */
  actingFor?: ActingUser;
}

/** A call the host refused because the plugin lacks a permission (spec 04, section 4.1, rule 1; ADR 0036). */
export interface PermissionRefusal {
  /** The exact permission the plugin needs, for example "content:write" or "network:fetch:api.example.com". */
  permission: string;
  /** `permission_denied`, `host_denied` for a network host that was not approved, or `user_denied` when the plugin has
   * the permission but the person it acts for may not do this (PL-38). Then `permission` is that person's missing
   * capability, for example "content.edit_any". */
  code: "permission_denied" | "host_denied" | "user_denied";
  /** For the developer: the hook or block, the exact permission, and how to fix it. */
  message: string;
}

/** A refusal with the plugin and the call it happened in, for the developer console. */
export interface DeveloperNote extends PermissionRefusal {
  pluginId: string;
  /** Not set when the plugin's call was already over (a late call from the plugin). */
  call?: { kind: CallKind; name: string };
}

export type CallResult = (
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
    }
) & {
  /** Every permission the plugin was refused during this call, once each. A refusal is not a failure (ADR 0036). */
  permissionRefusals?: PermissionRefusal[];
};

export type PluginStatus = "enabled" | "disabled" | "switched_off";

/** The answer to "may this be published?" (spec 04, section 5.3; PL-40). Only an explicit refusal from a plugin that
 * worked blocks publishing. A plugin that failed, crashed or took too long is skipped, and the owner is told. */
export interface PublishCheck {
  allowed: boolean;
  /** When not allowed: the plugin that refused and its message for the author. */
  refusal?: { pluginId: string; message: string };
  /** Plugins that could not check, so publishing went ahead without them. */
  skipped: { pluginId: string; why: "timeout" | "failed"; message: string }[];
}

/** What running a filter hook through every plugin gave (spec 04, section 7): the value after the last plugin that
 * changed it, what each plugin that changed it returned, and the plugins that were skipped because they failed. */
export interface FilterRun {
  value: unknown;
  applied: { pluginId: string; value: unknown }[];
  skipped: { pluginId: string; why: "timeout" | "failed"; message: string }[];
}

/** One note for the owner per plugin whose before-publish check could not run (PL-40), built from the audit trail. */
export interface PublishCheckNote {
  pluginId: string;
  message: string;
  count: number;
  firstAt: number;
  lastAt: number;
}

export interface OwnerNotice {
  pluginId: string;
  message: string;
  at: number;
}

/** What the owner is told about a permission a plugin was refused: one note for each plugin and permission,
 * however many times it happened (ADR 0036). */
export interface PermissionNote {
  pluginId: string;
  /** The exact permission. */
  permission: string;
  /** The plain sentence for the owner. */
  message: string;
  /** The hooks and blocks that were refused, in the order they first were. */
  calls: { kind: CallKind; name: string }[];
  count: number;
  /** When it first and last happened, in milliseconds. */
  firstAt: number;
  lastAt: number;
}
