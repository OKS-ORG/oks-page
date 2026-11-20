// Where the owner publishes an exported site to (spec 10, section 7.2; the Publish screen). A target is kept in the site's
// `settings` table under the key `publish-targets`; the result of the last publish to each is kept under `publish-last`.
// What a place needs to sign in (a password, a private key, a passphrase) is sealed with the site's secret key and never
// shown again: the screen only learns that one is saved.
import { newId, type SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import type { SiteSecrets } from "./secret-box.js";

export const PUBLISH_TARGETS_KEY = "publish-targets";
export const PUBLISH_LAST_KEY = "publish-last";
export const MAX_PUBLISH_TARGETS = 10;

export const PUBLISH_KINDS = ["folder", "zip", "sftp", "github", "netlify"] as const;
export type PublishKind = (typeof PUBLISH_KINDS)[number];

export const TARGET_SECRETS = ["password", "privateKey", "passphrase", "token"] as const;
export type TargetSecret = (typeof TARGET_SECRETS)[number];

/** What an SFTP place needs besides its secrets. */
export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  /** The server's host key fingerprint the owner confirmed (`SHA256:` and 43 characters). */
  hostKey: string;
  /** How the account signs in. */
  auth: "password" | "key";
}

/** What a GitHub Pages place needs besides its token. */
export interface GithubConfig {
  owner: string;
  repo: string;
  branch: string;
}

export interface PublishTargetConfig {
  id: string;
  kind: PublishKind;
  /** The name the owner gave it: "Client's server". */
  label: string;
  /**
   * A folder (an absolute path), the zip file (a plain name, written in the project's `publish` folder), or the folder on the
   * SFTP server.
   */
  path: string;
  sftp?: SftpConfig;
  github?: GithubConfig;
  /** Sealed secrets by name (never sent to a browser). */
  secrets?: Partial<Record<TargetSecret, string>>;
}

/** A place as the screen sees it: no secret, only which ones are saved. */
export type PublicPublishTarget = Omit<PublishTargetConfig, "secrets"> & {
  has: Record<TargetSecret, boolean>;
};

export const publicTarget = (t: PublishTargetConfig): PublicPublishTarget => {
  const { secrets, ...rest } = t;
  return {
    ...rest,
    has: {
      password: Boolean(secrets?.password),
      privateKey: Boolean(secrets?.privateKey),
      passphrase: Boolean(secrets?.passphrase),
      token: Boolean(secrets?.token),
    },
  };
};

/** Where a sealed secret is bound: it opens only for this place and this name. */
export const secretPlace = (id: string, name: TargetSecret): string => `publish:${id}:${name}`;

export interface PublishLast {
  at: number;
  ok: boolean;
  /** One plain sentence: what was sent, or what went wrong. */
  message: string;
}

export type PublishResult<T> =
  ({ ok: true } & T) | { ok: false; code: "forbidden" | "invalid" | "not_found"; message: string };

const fail = (code: "forbidden" | "invalid" | "not_found", message: string) =>
  ({ ok: false, code, message }) as const;

const parse = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

async function load(runner: SqlRunner, siteId: string, key: string): Promise<unknown> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, key],
  );
  return parse(rows[0]?.["value"]);
}

async function store(
  runner: SqlRunner,
  siteId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, key, JSON.stringify(value), new Date()],
  );
}

const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const HOST_KEY = /^SHA256:[A-Za-z0-9+/]{43}$/;

/** A saved list, with anything that is not a valid target left out. */
export function readTargets(raw: unknown): PublishTargetConfig[] {
  const parsed = parse(raw);
  const list = Array.isArray(parsed) ? (parsed as unknown[]) : [];
  const out: PublishTargetConfig[] = [];
  for (const item of list) {
    const t = item as Record<string, unknown> | null;
    if (
      !t ||
      typeof t["id"] !== "string" ||
      !(PUBLISH_KINDS as readonly string[]).includes(String(t["kind"])) ||
      typeof t["label"] !== "string" ||
      typeof t["path"] !== "string"
    )
      continue;
    const target: PublishTargetConfig = {
      id: t["id"],
      kind: t["kind"] as PublishKind,
      label: t["label"],
      path: t["path"],
    };
    if (target.kind === "sftp") {
      const s = t["sftp"] as Record<string, unknown> | null;
      if (
        !s ||
        typeof s["host"] !== "string" ||
        typeof s["port"] !== "number" ||
        typeof s["username"] !== "string" ||
        typeof s["hostKey"] !== "string" ||
        (s["auth"] !== "password" && s["auth"] !== "key")
      )
        continue;
      target.sftp = {
        host: s["host"],
        port: s["port"],
        username: s["username"],
        hostKey: s["hostKey"],
        auth: s["auth"],
      };
    }
    if (target.kind === "github") {
      const g = t["github"] as Record<string, unknown> | null;
      if (
        !g ||
        typeof g["owner"] !== "string" ||
        typeof g["repo"] !== "string" ||
        typeof g["branch"] !== "string"
      )
        continue;
      target.github = { owner: g["owner"], repo: g["repo"], branch: g["branch"] };
    }
    if (target.kind === "sftp" || target.kind === "github" || target.kind === "netlify") {
      const sealed = t["secrets"] as Record<string, unknown> | null;
      if (sealed && typeof sealed === "object") {
        target.secrets = {};
        for (const name of TARGET_SECRETS)
          if (typeof sealed[name] === "string") target.secrets[name] = sealed[name];
      }
    }
    out.push(target);
  }
  return out.slice(0, MAX_PUBLISH_TARGETS);
}

export async function listPublishTargets(
  runner: SqlRunner,
  siteId: string,
): Promise<PublishTargetConfig[]> {
  return readTargets(await load(runner, siteId, PUBLISH_TARGETS_KEY));
}

/** The path as it will be used, or the words for what is wrong with it. */
export function cleanTargetPath(
  kind: PublishKind,
  raw: string,
): { path: string } | { problem: string } {
  const path = raw.trim();
  if (path === "" || path.length > 500 || path.includes("\0"))
    return { problem: "Give the place a path of at most 500 characters." };
  if (kind === "folder") {
    // An absolute path on this computer: a Unix path, or a drive letter on Windows. Never the root itself.
    const unix = /^\/(?!\/)[^]*$/.test(path) && path !== "/";
    const windows = /^[A-Za-z]:[\\/][^]+$/.test(path);
    if (!unix && !windows)
      return {
        problem:
          "A folder needs the whole path, such as /var/www/site (not the main folder of the drive).",
      };
    if (path.split(/[\\/]/).includes("..")) return { problem: 'The path may not contain "..".' };
    return { path };
  }
  if (kind === "sftp") {
    // A folder on the server: whole (/var/www) or from the account's home (public_html). Never the root itself.
    if (path === "/" || path.includes("\\") || path.split("/").includes(".."))
      return {
        problem:
          'The folder on the server must be a path such as /var/www/site or public_html (not "/", no "..").',
      };
    return { path };
  }
  if (kind === "github") {
    // The repository, written as owner/name.
    if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(path) || path.endsWith(".git"))
      return { problem: "Give the repository as owner/name, such as ada/my-site." };
    return { path };
  }
  if (kind === "netlify") {
    // The site's name (my-site, my-site.netlify.app) or its id.
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/.test(path))
      return { problem: "Give the site's name or its id, such as my-site or my-site.netlify.app." };
    return { path };
  }
  // A zip file is written in the project's own `publish` folder: only its name is chosen.
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}\.zip$/.test(path))
    return { problem: "The zip file needs a plain name ending in .zip, such as site.zip." };
  return { path };
}

/** Adds a target, or changes the one with this id. `box` seals the secrets of an SFTP place. */
export async function savePublishTarget(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: Record<string, unknown>,
  box?: SiteSecrets,
): Promise<PublishResult<{ target: PublishTargetConfig }>> {
  if (!actor.can("settings.manage")) return fail("forbidden", "You may not change the settings.");
  const kind = String(input["kind"] ?? "");
  if (!(PUBLISH_KINDS as readonly string[]).includes(kind))
    return fail("invalid", "Choose a folder, a zip file, an SFTP server, GitHub Pages or Netlify.");
  const label = String(input["label"] ?? "").trim();
  if (label === "" || label.length > 60)
    return fail("invalid", "Give it a name of at most 60 characters.");
  const cleaned = cleanTargetPath(kind as PublishKind, String(input["path"] ?? ""));
  if ("problem" in cleaned) return fail("invalid", cleaned.problem);
  const all = await listPublishTargets(runner, siteId);
  const id = typeof input["id"] === "string" && input["id"] !== "" ? input["id"] : null;
  const before = id ? all.find((t) => t.id === id) : undefined;
  if (id && !before) return fail("not_found", "This place does not exist.");
  if (!id && all.length >= MAX_PUBLISH_TARGETS)
    return fail("invalid", `A site can have at most ${MAX_PUBLISH_TARGETS} places to publish to.`);
  const target: PublishTargetConfig = {
    id: id ?? newId(),
    kind: kind as PublishKind,
    label,
    path: cleaned.path,
  };

  if (kind === "sftp") {
    const host = String(input["host"] ?? "").trim();
    if (!HOST.test(host))
      return fail("invalid", "Give the server's address, such as sftp.example.com.");
    const port = input["port"] === undefined || input["port"] === "" ? 22 : Number(input["port"]);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return fail("invalid", "The port is a number from 1 to 65535 (usually 22).");
    const username = String(input["username"] ?? "").trim();
    if (!/^[^\s\0:]{1,64}$/.test(username))
      return fail("invalid", "Give the user name (up to 64 characters, no spaces).");
    const hostKey = String(input["hostKey"] ?? "").trim();
    if (!HOST_KEY.test(hostKey))
      return fail(
        "invalid",
        'Check the server first and confirm its fingerprint with "Check the server".',
      );
    const auth = input["auth"] === "key" ? "key" : "password";
    // The secrets: left out keeps the saved one, an empty one removes it, anything else replaces it.
    const secrets: Partial<Record<TargetSecret, string>> = { ...(before?.secrets ?? {}) };
    for (const name of TARGET_SECRETS) {
      const value = input[name];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.length > 20_000)
        return fail("invalid", `The ${name === "privateKey" ? "private key" : name} is not valid.`);
      if (value === "") delete secrets[name];
      else {
        if (name === "privateKey" && !value.includes("-----BEGIN"))
          return fail(
            "invalid",
            "The private key must be pasted whole, from the line that starts with -----BEGIN.",
          );
        if (!box)
          return fail(
            "invalid",
            "A password or key can be saved only when the site's OKS_SECRET (at least 32 characters) is set in its .env file.",
          );
        secrets[name] = box.seal(value, secretPlace(target.id, name));
      }
    }
    // What the chosen way of signing in needs, and nothing else is kept.
    if (auth === "password") {
      delete secrets.privateKey;
      delete secrets.passphrase;
      if (!secrets.password) return fail("invalid", "Give the password.");
    } else {
      delete secrets.password;
      if (!secrets.privateKey) return fail("invalid", "Paste the private key.");
    }
    target.sftp = { host, port, username, hostKey, auth };
    target.secrets = secrets;
  }

  if (kind === "github" || kind === "netlify") {
    let github: GithubConfig | undefined;
    if (kind === "github") {
      const [owner = "", repo = ""] = cleaned.path.split("/");
      const branch = String(input["branch"] ?? "").trim() || "gh-pages";
      if (
        !/^[A-Za-z0-9._/-]{1,100}$/.test(branch) ||
        branch.startsWith("/") ||
        branch.endsWith("/") ||
        branch.includes("//") ||
        branch.includes("..")
      )
        return fail("invalid", "The branch is a name such as gh-pages.");
      github = { owner, repo, branch };
    }
    const secrets: Partial<Record<TargetSecret, string>> = { ...(before?.secrets ?? {}) };
    const token = input["token"];
    if (token !== undefined) {
      if (typeof token !== "string" || token.length > 500)
        return fail("invalid", "The token is not valid.");
      if (token === "") delete secrets.token;
      else {
        if (!box)
          return fail(
            "invalid",
            "A token can be saved only when the site's OKS_SECRET (at least 32 characters) is set in its .env file.",
          );
        secrets.token = box.seal(token, secretPlace(target.id, "token"));
      }
    }
    if (!secrets.token) return fail("invalid", "Give the token.");
    if (github) target.github = github;
    target.secrets = { token: secrets.token };
  }

  await store(
    runner,
    siteId,
    PUBLISH_TARGETS_KEY,
    id ? all.map((t) => (t.id === id ? target : t)) : [...all, target],
  );
  return { ok: true, target };
}

export async function deletePublishTarget(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<PublishResult<object>> {
  if (!actor.can("settings.manage")) return fail("forbidden", "You may not change the settings.");
  const all = await listPublishTargets(runner, siteId);
  if (!all.some((t) => t.id === id)) return fail("not_found", "This place does not exist.");
  await store(
    runner,
    siteId,
    PUBLISH_TARGETS_KEY,
    all.filter((t) => t.id !== id),
  );
  const last = await loadPublishLast(runner, siteId);
  if (id in last) {
    delete last[id];
    await store(runner, siteId, PUBLISH_LAST_KEY, last);
  }
  return { ok: true };
}

/** What the last publish to each place did, by the place's id. */
export async function loadPublishLast(
  runner: SqlRunner,
  siteId: string,
): Promise<Record<string, PublishLast>> {
  const raw = await load(runner, siteId, PUBLISH_LAST_KEY);
  const out: Record<string, PublishLast> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      const r = v as Record<string, unknown> | null;
      if (
        r &&
        typeof r["at"] === "number" &&
        typeof r["ok"] === "boolean" &&
        typeof r["message"] === "string"
      )
        out[id] = { at: r["at"], ok: r["ok"], message: r["message"].slice(0, 500) };
    }
  return out;
}

export async function recordPublishLast(
  runner: SqlRunner,
  siteId: string,
  id: string,
  result: PublishLast,
): Promise<void> {
  const last = await loadPublishLast(runner, siteId);
  last[id] = { ...result, message: result.message.slice(0, 500) };
  await store(runner, siteId, PUBLISH_LAST_KEY, last);
}
