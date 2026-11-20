// Getting a plugin file out of an npm package (spec 04, section 10, step 2): the registry says where the package's tarball is
// and its hash; the tarball is downloaded within size limits, checked against that hash, and the one `.oksplugin` file that
// `oks pack` put in the package is read out of it. Nothing from the package is run. The same file can then be checked and
// added like an uploaded one.
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { PLUGIN_FILE_MAX_BYTES } from "./plugin-file.js";

export const NPM_REGISTRY = "https://registry.npmjs.org";
/** The biggest tarball taken from the registry (compressed). */
export const NPM_TARBALL_MAX_BYTES = 10 * 1024 * 1024;
const METADATA_MAX_BYTES = 2 * 1024 * 1024;

const NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/;

export type NpmResult =
  { ok: true; text: string; name: string; version: string } | { ok: false; message: string };

const bad = (message: string): NpmResult => ({ ok: false, message });

/** Reads a response body, stopping at a limit. */
async function readLimited(response: Response, max: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > max || !response.body) return declared > max ? null : Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * The first file of a tar archive (already unzipped) whose path matches. Only plain files are read; the archive's own
 * paths are never used to write anything. Returns null when there is none, and "many" when more than one matches.
 */
export function findInTar(tar: Buffer, wanted: (path: string) => boolean): Buffer | null | "many" {
  let found: Buffer | null = null;
  let longName: string | null = null;
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(
      header.subarray(124, 136).toString("latin1").replace(/\0.*$/, "").trim() || "0",
      8,
    );
    if (!Number.isFinite(size) || size < 0) return null;
    const type = String.fromCharCode(header[156] ?? 0);
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    if (type === "x" || type === "g") continue;
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const base = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const name = longName ?? (prefix ? `${prefix}/${base}` : base);
    longName = null;
    if ((type === "0" || type === "\0") && wanted(name)) {
      if (found) return "many";
      found = Buffer.from(body);
    }
  }
  return found;
}

/**
 * Downloads a plugin from an npm package. `version` is an exact version, or empty for the latest. `registry` is the
 * operator's registry address (the public one by default); the tarball must come from the same host.
 */
export async function fetchPluginFromNpm(
  name: string,
  version: string,
  options: { registry?: string; fetchImpl?: typeof fetch } = {},
): Promise<NpmResult> {
  const registry = (options.registry ?? NPM_REGISTRY).replace(/\/+$/, "");
  const get = options.fetchImpl ?? fetch;
  if (name.length > 214 || !NAME.test(name))
    return bad("That is not an npm package name. It looks like my-plugin or @author/my-plugin.");
  if (version !== "" && !VERSION.test(version))
    return bad("The version must look like 1.2.0, or be left empty for the latest.");
  const base = new URL(registry);
  const secure = base.protocol === "https:";
  const sameHost = (url: URL) => url.host === base.host && url.protocol === base.protocol;
  const ask = async (url: string, max: number): Promise<Buffer | string> => {
    let response: Response;
    try {
      // A redirect is not followed: the address was checked, and an answer from somewhere else is not trusted.
      response = await get(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch {
      return "The npm registry could not be reached.";
    }
    if (response.status === 404) return "There is no such package or version on npm.";
    if (!response.ok) return `The npm registry answered with an error (${response.status}).`;
    const body = await readLimited(response, max);
    return body ?? "The download is bigger than the limit.";
  };
  if (!secure && !["127.0.0.1", "localhost"].includes(base.hostname))
    return bad("The registry address must use https.");
  const meta = await ask(
    `${registry}/${name.replace("/", "%2F")}/${version === "" ? "latest" : version}`,
    METADATA_MAX_BYTES,
  );
  if (typeof meta === "string") return bad(meta);
  let info: {
    name?: unknown;
    version?: unknown;
    dist?: { tarball?: unknown; integrity?: unknown; shasum?: unknown };
  };
  try {
    info = JSON.parse(meta.toString("utf8")) as typeof info;
  } catch {
    return bad("The npm registry gave an answer that cannot be read.");
  }
  const tarball = typeof info.dist?.tarball === "string" ? info.dist.tarball : "";
  let tarUrl: URL;
  try {
    tarUrl = new URL(tarball);
  } catch {
    return bad("The package has no download address.");
  }
  if (!sameHost(tarUrl))
    return bad("The package's download is on another host, so it is not used.");
  if (typeof info.version !== "string" || typeof info.name !== "string" || info.name !== name)
    return bad("The registry's answer does not match the package asked for.");
  const packed = await ask(tarUrl.href, NPM_TARBALL_MAX_BYTES);
  if (typeof packed === "string") return bad(packed);
  // The hash the registry published must match what was downloaded: sha512 when it has one, sha1 otherwise.
  const integrity = typeof info.dist?.integrity === "string" ? info.dist.integrity : "";
  const shasum = typeof info.dist?.shasum === "string" ? info.dist.shasum : "";
  const sri = /^sha512-(.+)$/.exec(integrity);
  if (sri) {
    if (createHash("sha512").update(packed).digest("base64") !== sri[1])
      return bad("The download does not match the hash the registry published, so it is not used.");
  } else if (shasum) {
    if (createHash("sha1").update(packed).digest("hex") !== shasum)
      return bad("The download does not match the hash the registry published, so it is not used.");
  } else return bad("The registry published no hash for this package, so it is not used.");
  let tar: Buffer;
  try {
    tar = gunzipSync(packed, { maxOutputLength: 4 * PLUGIN_FILE_MAX_BYTES });
  } catch {
    return bad("The package could not be unpacked, or it is too big when unpacked.");
  }
  // `oks pack` writes the file into the package root; npm puts every file under "package/".
  const file = findInTar(tar, (p) => /^package\/[^/]+\.oksplugin$/.test(p));
  if (file === null)
    return bad(
      "This package has no plugin file (.oksplugin). Its author must run `oks pack` before publishing.",
    );
  if (file === "many") return bad("This package has more than one plugin file.");
  if (file.length > PLUGIN_FILE_MAX_BYTES) return bad("The plugin file in the package is too big.");
  return { ok: true, text: file.toString("utf8"), name: info.name, version: info.version };
}
