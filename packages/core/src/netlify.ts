// A place to publish to on Netlify (spec 10, section 7.2): a deploy. The list of files with a hash of each is sent first;
// Netlify says which of them it does not already have, only those are uploaded, and the deploy goes live in one step when
// they have all arrived. A visitor sees the old site or the new one, never a mixture, and a publish that is cut off leaves
// the live site as it was. Netlify reads the `_redirects` file of the export itself. The token only goes to Netlify.
import { createHash } from "node:crypto";
import { isSafePath, type PublishTarget } from "./publish.js";

export const NETLIFY_API = "https://api.netlify.com/api/v1";
/** The most a deploy may hold in memory before it is sent: a bigger site is better sent from another place. */
export const NETLIFY_MAX_BYTES = 300 * 1024 * 1024;

export interface NetlifyOptions {
  /** The site's name (`my-site`, `my-site.netlify.app`) or its id. */
  site: string;
  /** A personal access token. */
  token: string;
  /** For tests: the address of the API. */
  apiBase?: string;
  timeoutMs?: number;
  /** How long to wait between two looks at how the deploy is going, in milliseconds. */
  pollMs?: number;
  /** The longest to wait for the deploy to go live, in milliseconds. */
  waitMs?: number;
}

/** What went wrong, in plain words, from Netlify's answer. */
export function plainNetlifyError(status: number, message: string, site: string): string {
  if (status === 401) return "Netlify refused the token. It may be wrong, expired or taken back.";
  if (status === 403) return "Netlify did not allow that. The token may not deploy this site.";
  if (status === 404)
    return `Netlify could not find the site ${site}, or the token has no access to it.`;
  if (status === 429)
    return "Netlify says too many requests were made. Wait a while and publish again.";
  return `Netlify answered with an error (${status}): ${message.slice(0, 160)}`;
}

/** A place on Netlify. Every file is held until the end, then deployed as one. */
export function netlifyTarget(o: NetlifyOptions): PublishTarget {
  const base = (o.apiBase ?? NETLIFY_API).replace(/\/+$/, "");
  const files = new Map<string, Buffer>();
  let held = 0;

  async function api(
    method: string,
    path: string,
    body?: unknown,
    raw?: Buffer,
  ): Promise<{ status: number; json: unknown; text: string }> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
        headers: {
          authorization: `Bearer ${o.token}`,
          "user-agent": "oks-page-publish",
          ...(raw
            ? { "content-type": "application/octet-stream" }
            : body !== undefined
              ? { "content-type": "application/json" }
              : {}),
        },
        ...(raw
          ? { body: new Uint8Array(raw) }
          : body !== undefined
            ? { body: JSON.stringify(body) }
            : {}),
      });
    } catch (error) {
      throw new Error("Netlify could not be reached.", { cause: error });
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  }

  const fail = (status: number, json: unknown, text: string): never => {
    const message = (json as { message?: unknown } | null)?.message;
    throw new Error(
      plainNetlifyError(status, typeof message === "string" ? message : text, o.site),
    );
  };

  return {
    async previous() {
      // Netlify keeps the digests of every earlier deploy: the whole list is sent each time, and only what it lacks is uploaded.
      return null;
    },
    async put(path, bytes) {
      if (!isSafePath(path)) throw new Error(`"${path}" is not a safe file name`);
      held += bytes.length;
      if (held > NETLIFY_MAX_BYTES)
        throw new Error(
          "The site is too big to be deployed from here in one go. Use another place.",
        );
      files.set(path, bytes);
    },
    async remove(path) {
      files.delete(path);
    },
    async finish() {
      const digests = new Map<string, string>();
      for (const [path, bytes] of files)
        digests.set(`/${path}`, createHash("sha1").update(bytes).digest("hex"));
      const site = encodeURIComponent(o.site);
      const created = await api("POST", `/sites/${site}/deploys`, {
        files: Object.fromEntries(digests),
      });
      if (created.status !== 200 && created.status !== 201)
        fail(created.status, created.json, created.text);
      const deploy = created.json as { id?: string; required?: string[] };
      if (!deploy.id) throw new Error("Netlify did not start the deploy.");
      // Each file Netlify lacks is uploaded once (several files with the same content share one upload).
      const wanted = new Set(deploy.required ?? []);
      for (const [path, digest] of digests) {
        if (!wanted.has(digest)) continue;
        wanted.delete(digest);
        const bytes = files.get(path.slice(1))!;
        const sent = await api(
          "PUT",
          `/deploys/${deploy.id}/files/${path.slice(1).split("/").map(encodeURIComponent).join("/")}`,
          undefined,
          bytes,
        );
        if (sent.status !== 200 && sent.status !== 201) fail(sent.status, sent.json, sent.text);
      }
      // The deploy goes live by itself when it is ready.
      const started = Date.now();
      for (;;) {
        const state = await api("GET", `/deploys/${deploy.id}`);
        if (state.status !== 200) fail(state.status, state.json, state.text);
        const d = state.json as { state?: string; error_message?: string };
        if (d.state === "ready") return;
        if (d.state === "error")
          throw new Error(
            `Netlify could not finish the deploy: ${(d.error_message ?? "no reason given").slice(0, 160)}`,
          );
        if (Date.now() - started > (o.waitMs ?? 300_000))
          throw new Error(
            "Netlify took too long to finish the deploy. Look at the site's Deploys page.",
          );
        await new Promise((r) => setTimeout(r, o.pollMs ?? 1000));
      }
    },
  };
}
