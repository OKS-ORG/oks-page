// A small stand-in for the parts of Netlify's API that a deploy uses (create a deploy with the list of file digests, upload the
// files it asks for, look at how the deploy is going), for tests. It answers on the loopback address only. It is written
// from the documented API, so it is not proof that Netlify itself answers the same.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const TEST_NETLIFY_TOKEN = "nfp_test0123456789abcdefghijklmnop";

export interface TestNetlifyServer {
  base: string;
  /** The files of the live site, by path (text). */
  live(): Map<string, string>;
  /** How many deploys went live. */
  deploys(): number;
  /** The files that were uploaded (not counting those Netlify already had), by path, in order. */
  uploads: string[];
  /** Make every upload from the n-th on fail. */
  failUploadsFrom(n: number | null): void;
  /** Make deploys stay "processing" for ever. */
  stall(on: boolean): void;
  /** Make the next deploy end in an error with this message. */
  failNextDeploy(message: string | null): void;
  close(): Promise<void>;
}

export async function startNetlifyServer(site = "my-site"): Promise<TestNetlifyServer> {
  const known = new Map<string, Buffer>(); // digest -> bytes, kept across deploys
  const pending = new Map<
    string,
    { files: Record<string, string>; required: Set<string>; polls: number; error: string | null }
  >();
  let live = new Map<string, string>();
  let deployCount = 0;
  let uploadCount = 0;
  let failFrom: number | null = null;
  let failMessage: string | null = null;
  let stalled = false;
  const uploads: string[] = [];

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      const data = Buffer.concat(chunks);
      const url = new URL(request.url ?? "/", "http://x");
      const method = request.method ?? "GET";
      const send = (status: number, body: unknown) => {
        response.statusCode = status;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization !== `Bearer ${TEST_NETLIFY_TOKEN}`)
        return send(401, { message: "Access Denied" });
      const create = new RegExp(`^/sites/${site.replace(/\./g, "\\.")}/deploys$`).exec(
        url.pathname,
      );
      if (method === "POST" && create) {
        let body: { files?: Record<string, string> };
        try {
          body = JSON.parse(data.toString("utf8")) as typeof body;
        } catch {
          return send(400, { message: "invalid JSON" });
        }
        const files = body.files ?? {};
        const required = new Set(Object.values(files).filter((d) => !known.has(d)));
        const id = `deploy${++deployCount}`;
        const error = failMessage;
        failMessage = null;
        pending.set(id, { files, required, polls: 0, error });
        return send(200, {
          id,
          state: required.size > 0 ? "uploading" : "prepared",
          required: [...required],
        });
      }
      if (method === "POST" && url.pathname.startsWith("/sites/"))
        return send(404, { message: "Not Found" });
      const put = /^\/deploys\/([^/]+)\/files\/(.+)$/.exec(url.pathname);
      if (method === "PUT" && put) {
        const d = pending.get(put[1]!);
        if (!d) return send(404, { message: "Not Found" });
        uploadCount++;
        if (failFrom !== null && uploadCount >= failFrom)
          return send(500, { message: "Server Error" });
        const path = `/${decodeURIComponent(put[2]!)}`;
        const digest = createHash("sha1").update(data).digest("hex");
        if (d.files[path] !== digest)
          return send(422, { message: "the file does not match its digest" });
        known.set(digest, data);
        d.required.delete(digest);
        uploads.push(path.slice(1));
        return send(200, { id: digest });
      }
      const status = /^\/deploys\/([^/]+)$/.exec(url.pathname);
      if (method === "GET" && status) {
        const d = pending.get(status[1]!);
        if (!d) return send(404, { message: "Not Found" });
        if (d.required.size > 0) return send(200, { state: "uploading" });
        if (stalled) return send(200, { state: "processing" });
        d.polls++;
        if (d.polls === 1) return send(200, { state: "processing" });
        if (d.error) return send(200, { state: "error", error_message: d.error });
        // The deploy goes live as one: every file at once.
        live = new Map(
          Object.entries(d.files).map(([p, digest]) => [
            p.slice(1),
            known.get(digest)!.toString("utf8"),
          ]),
        );
        return send(200, { state: "ready" });
      }
      return send(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    live: () => live,
    deploys: () => deployCount,
    uploads,
    failUploadsFrom(n) {
      failFrom = n;
      uploadCount = 0;
    },
    stall(on) {
      stalled = on;
    },
    failNextDeploy(message) {
      failMessage = message;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
