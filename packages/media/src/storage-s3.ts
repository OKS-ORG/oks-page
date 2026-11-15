// Spec 09 section 7: the S3-compatible storage adapter (Amazon S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces,
// SeaweedFS, Garage). The same five calls as the local disk. Requests are signed with AWS Signature Version 4, written here
// with node:crypto, so no cloud SDK is needed. The bucket can stay private: files are still served by the site at
// /uploads/<key>, with the protective headers of section 8, unless a public address for the bucket is set.

import { createHash, createHmac } from "node:crypto";
import { assertSafeKey, type StorageAdapter } from "./storage.js";

export interface S3AdapterOptions {
  /** The bucket's name. */
  bucket: string;
  /** For example "eu-central-1"; Cloudflare R2 uses "auto". */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The service's address, for example "https://<account>.r2.cloudflarestorage.com". Default: Amazon S3 in the region. */
  endpoint?: string;
  /** Bucket in the path (endpoint/bucket/key) instead of the host name (bucket.endpoint/key). Default: on for an endpoint
   * that is not Amazon's. */
  pathStyle?: boolean;
  /** Put every key under this folder, for example "my-site/". */
  prefix?: string;
  /** The address files are served from. Default "/uploads" (through the site, with its protective headers). */
  baseUrl?: string;
  /** For tests. */
  fetch?: typeof fetch;
  /** For tests: the time a request is signed at. */
  now?: () => Date;
}

const hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding of one part of a path, as S3 signs it. */
const encodePart = (part: string) =>
  encodeURIComponent(part).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const encodePath = (path: string) => path.split("/").map(encodePart).join("/");

export interface SignInput {
  method: string;
  /** The URL as it will be requested; its path must already be encoded. */
  url: URL;
  /** Headers to sign, lower case names (host is added from the URL). */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
}

/** Signs a request (AWS Signature Version 4) and returns the headers to send, Authorization included. */
export function signS3Request(input: SignInput): Record<string, string> {
  const amzDate = input.date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    "x-amz-content-sha256": input.payloadHash,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names
    .map((n) => `${n}:${String(lower[n]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => [encodePart(k), encodePart(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    input.method,
    input.url.pathname,
    query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonical)].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const out = Object.fromEntries(Object.entries(headers).filter(([n]) => n !== "host"));
  out["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

/** A refusal from the storage service, in plain words; never the keys. */
export class StorageError extends Error {}

const plainError = async (response: Response, what: string): Promise<StorageError> => {
  const body = await response.text().catch(() => "");
  const code = /<Code>([^<]{1,64})<\/Code>/.exec(body)?.[1] ?? "";
  const reason =
    response.status === 403
      ? "the storage refused the access key (check the key, the secret and the bucket's permissions)"
      : code === "NoSuchBucket"
        ? "the bucket does not exist"
        : `the storage answered ${response.status}`;
  return new StorageError(`${what}: ${reason}${code ? ` (${code})` : ""}.`);
};

export interface S3Client {
  /** Sends one signed request for a path inside the bucket ("" is the bucket itself), with an optional query. */
  request(
    method: string,
    key: string,
    body?: Uint8Array,
    query?: Record<string, string>,
  ): Promise<Response>;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (text: string) =>
  text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e.startsWith("#x")
      ? String.fromCodePoint(Number.parseInt(e.slice(2), 16))
      : e.startsWith("#")
        ? String.fromCodePoint(Number.parseInt(e.slice(1), 10))
        : XML_ENTITIES[e]!,
  );

/** The signed requests to one bucket. */
export function s3Client(options: S3AdapterOptions): S3Client {
  const endpoint = new URL(options.endpoint ?? `https://s3.${options.region}.amazonaws.com`);
  const amazon = /(^|\.)amazonaws\.com$/.test(endpoint.hostname);
  const pathStyle = options.pathStyle ?? !amazon;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const base = endpoint.pathname.replace(/\/$/, "");
  return {
    async request(method, key, body, query) {
      const path = key ? `/${encodePath(key)}` : "";
      const url = pathStyle
        ? new URL(
            `${endpoint.protocol}//${endpoint.host}${base}/${encodePart(options.bucket)}${path}`,
          )
        : new URL(`${endpoint.protocol}//${options.bucket}.${endpoint.host}${base}${path || "/"}`);
      for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
      const headers = signS3Request({
        method,
        url,
        headers: {},
        payloadHash: hex(body ?? new Uint8Array()),
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        date: now(),
      });
      return doFetch(url, {
        method,
        headers,
        ...(body ? { body: body as unknown as BodyInit } : {}),
        signal: AbortSignal.timeout(60_000),
      });
    },
  };
}

export function s3Adapter(options: S3AdapterOptions): StorageAdapter {
  const client = s3Client(options);
  const prefix = options.prefix ? options.prefix.replace(/^\/+|\/+$/g, "") + "/" : "";
  if (prefix) assertSafeKey(prefix.slice(0, -1));
  const baseUrl = (options.baseUrl ?? "/uploads").replace(/\/$/, "");
  const full = (key: string) => {
    assertSafeKey(key);
    return prefix + key;
  };
  return {
    async put(key, bytes) {
      const response = await client.request("PUT", full(key), bytes);
      if (!response.ok) throw await plainError(response, "The file could not be stored");
      await response.arrayBuffer().catch(() => undefined);
    },
    async get(key) {
      const response = await client.request("GET", full(key));
      if (!response.ok) throw await plainError(response, "The file could not be read");
      return new Uint8Array(await response.arrayBuffer());
    },
    async delete(key) {
      const response = await client.request("DELETE", full(key));
      // Deleting a file that is not there is fine, as on the local disk.
      if (!response.ok && response.status !== 404)
        throw await plainError(response, "The file could not be deleted");
      await response.arrayBuffer().catch(() => undefined);
    },
    async exists(key) {
      let path: string;
      try {
        path = full(key);
      } catch {
        return false;
      }
      const response = await client.request("HEAD", path);
      await response.arrayBuffer().catch(() => undefined);
      if (response.status === 404) return false;
      if (!response.ok) throw await plainError(response, "The file could not be checked");
      return true;
    },
    publicUrl(key) {
      assertSafeKey(key);
      return `${baseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
    },
    async *list() {
      // ListObjectsV2, 1,000 keys a page; only the keys under the prefix, without it.
      let token: string | null = null;
      do {
        const query: Record<string, string> = { "list-type": "2", "max-keys": "1000" };
        if (prefix) query["prefix"] = prefix;
        if (token) query["continuation-token"] = token;
        const response = await client.request("GET", "", undefined, query);
        if (!response.ok) throw await plainError(response, "The files could not be listed");
        const xml = await response.text();
        for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
          const key = unescapeXml(match[1]!);
          if (key.startsWith(prefix) && key.length > prefix.length) yield key.slice(prefix.length);
        }
        const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
        const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
        token = truncated && next ? unescapeXml(next[1]!) : null;
      } while (token);
    },
  };
}

/**
 * The S3 settings from the environment (OKS_STORAGE=s3 and the OKS_S3_* values), or null for the local disk. Missing or
 * odd values are refused in plain words, so a site never starts writing to the wrong place.
 */
export function s3OptionsFromEnv(env: Record<string, string | undefined>): S3AdapterOptions | null {
  const kind = (env["OKS_STORAGE"] ?? "local").trim().toLowerCase();
  if (kind === "local" || kind === "") return null;
  if (kind !== "s3") throw new StorageError(`OKS_STORAGE must be "local" or "s3", not "${kind}".`);
  const missing = ["OKS_S3_BUCKET", "OKS_S3_ACCESS_KEY_ID", "OKS_S3_SECRET_ACCESS_KEY"].filter(
    (n) => !env[n]?.trim(),
  );
  if (missing.length > 0) throw new StorageError(`S3 storage needs ${missing.join(", ")}.`);
  const pathStyle = env["OKS_S3_PATH_STYLE"]?.trim().toLowerCase();
  if (pathStyle && pathStyle !== "true" && pathStyle !== "false")
    throw new StorageError(`OKS_S3_PATH_STYLE must be "true" or "false".`);
  const endpoint = env["OKS_S3_ENDPOINT"]?.trim();
  if (endpoint) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new StorageError("OKS_S3_ENDPOINT must be an address such as https://s3.example.com.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new StorageError("OKS_S3_ENDPOINT must start with https://.");
  }
  return {
    bucket: env["OKS_S3_BUCKET"]!.trim(),
    region: env["OKS_S3_REGION"]?.trim() || "us-east-1",
    accessKeyId: env["OKS_S3_ACCESS_KEY_ID"]!.trim(),
    secretAccessKey: env["OKS_S3_SECRET_ACCESS_KEY"]!.trim(),
    ...(endpoint ? { endpoint } : {}),
    ...(pathStyle ? { pathStyle: pathStyle === "true" } : {}),
    ...(env["OKS_S3_PREFIX"]?.trim() ? { prefix: env["OKS_S3_PREFIX"].trim() } : {}),
  };
}
