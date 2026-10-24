// Test helpers shared by the auth tests.
import { pgSchema, sqliteSchema } from "@oks-page/db";
import type { TestDb } from "@oks-page/db/testing";
import { createAuth, type CreateAuthOptions, type OksAuth } from "./create-auth.js";

export const SECRET = "s".repeat(40);
export const BASE_URL = "http://localhost:3000";

export function authFor(db: TestDb, extra: Partial<CreateAuthOptions> = {}): OksAuth {
  return createAuth({
    db: db.drizzle(db.kind === "sqlite" ? sqliteSchema : pgSchema),
    runner: db.runner,
    secret: SECRET,
    baseUrl: BASE_URL,
    ...extra,
  });
}

export const post = (
  a: OksAuth,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  remoteAddress = "203.0.113.1",
) =>
  a.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL, ...headers },
      body: JSON.stringify(body),
    }),
    { remoteAddress },
  );

/** Turn Set-Cookie headers into a Cookie header. */
export const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

// ---- a real HTTP server around the handler, for tests that drive a browser ----
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";

async function toRequest(req: IncomingMessage, base: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers))
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const init: RequestInit = { method: req.method ?? "GET", headers };
  if (body && req.method !== "GET" && req.method !== "HEAD") init.body = body;
  return new Request(new URL(req.url ?? "/", base), init);
}

async function send(res: ServerResponse, response: Response) {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((v, k) => {
    if (k !== "set-cookie") headers[k] = v;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers).end(Buffer.from(await response.arrayBuffer()));
}

export interface TestServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Start a server on a free port. `page` is the HTML of "/"; everything under /api/auth goes to the handler. */
export async function startServer(
  getHandler: () => OksAuth["handler"],
  page: () => string,
): Promise<{ server: Server; port: number }> {
  let base = "";
  const server = createServer(async (req, res) => {
    try {
      if (req.url?.startsWith("/api/auth"))
        return void (await send(
          res,
          await getHandler()(
            await toRequest(req, base),
            req.socket.remoteAddress ? { remoteAddress: req.socket.remoteAddress } : {},
          ),
        ));
      res.writeHead(200, { "content-type": "text/html" }).end(page());
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://localhost:${port}`;
  return { server, port };
}

/** A Chromium or Chrome to drive, or null. In CI one must exist. */
export function findBrowser(): string | null {
  const candidates = [
    process.env["CHROMIUM_PATH"],
    "/opt/pw-browsers/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((p): p is string => Boolean(p) && existsSync(p!)) ?? null;
}
