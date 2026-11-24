// /api/oks/plugins/<plugin>/<route>: the addresses a plugin adds (spec 04, section 9; permission `routes:public`).
// The site reads the request (at most the size the route declared, never more than 100 000 bytes), hands the plugin only
// the parts it needs, and turns the plugin's answer into JSON, plain text or a redirect to a page of this site. A plugin
// never sees headers or cookies, and a plugin that is off, missing or not allowed the permission gives a plain 404.
import {
  ROUTE_BODY_DEFAULT,
  ROUTE_BODY_MOST,
  type RouteFile,
  type RouteRequest,
} from "@oks-page/sandbox";
import { NextResponse } from "next/server";
import { signedInMember } from "./admin-session";
import { isSameOrigin } from "./api-entries";
import { getRunner } from "./db";
import { receiveFiles } from "./plugin-files";
import { pluginHost } from "./plugin-runtime";

const MINUTE = 60 * 1000;
const PER_MINUTE = 60;
const seen = new Map<string, number[]>();

/** True when this visitor has used a plugin's addresses too often in the last minute (counted in memory only). */
export function tooOften(key: string, now = Date.now()): boolean {
  const recent = (seen.get(key) ?? []).filter((t) => now - t < MINUTE);
  if (recent.length >= PER_MINUTE) {
    seen.set(key, recent);
    return true;
  }
  recent.push(now);
  seen.set(key, recent);
  if (seen.size > 5000)
    for (const [k, v] of seen) if (v.every((t) => now - t >= MINUTE)) seen.delete(k);
  return false;
}

const escape = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** The small page a plugin may ask for ("Thank you"): its title and text only, escaped, with a link back to the site. */
function pageHtml(title: string, text: string, problem: boolean): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((t) => t.trim())
    .filter((t) => t !== "")
    .map((t) => `<p>${escape(t)}</p>`)
    .join("");
  const body = problem ? `<div role="alert">${paragraphs}</div>` : paragraphs;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title></head><body><main style="max-width:40rem;margin:4rem auto;padding:0 1rem;font-family:system-ui,sans-serif"><h1>${escape(title)}</h1>${body}<p><a href="/">Back to the site</a></p></main></body></html>`;
}

const HEADERS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
const fail = (status: number, message: string) =>
  NextResponse.json({ error: { message } }, { status, headers: HEADERS });

/** The body as text, or null when it is bigger than `max` bytes (the rest is never read). */
async function readLimited(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** What a form sent with `multipart/form-data` holds: the text answers, and the files (a file input left empty is no file). */
interface MultipartForm {
  /** The text answers as `a=1&b=2`, so a plugin reads them like any other form. */
  text: string;
  files: { field: string; name: string; bytes: Uint8Array }[];
}

/**
 * Reads a form that may carry files, never more than the files and the text the route allows. Returns `"too_big"` when it
 * is more, `"bad"` when it cannot be read.
 */
async function readMultipart(
  request: Request,
  textMax: number,
  uploads: { files: number; maxFileBytes: number },
): Promise<MultipartForm | "too_big" | "bad"> {
  const cap = uploads.files * uploads.maxFileBytes + textMax + 64 * 1024;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > cap) return "too_big";
  if (!request.body) return "bad";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return "too_big";
    }
    chunks.push(value);
  }
  let form: FormData;
  try {
    form = await new Response(Buffer.concat(chunks), {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    return "bad";
  }
  const params = new URLSearchParams();
  const files: MultipartForm["files"] = [];
  for (const [field, value] of form) {
    if (typeof value === "string") params.append(field, value);
    else if (value.size > 0 || value.name !== "")
      files.push({ field, name: value.name, bytes: new Uint8Array(await value.arrayBuffer()) });
  }
  const text = params.toString();
  return Buffer.byteLength(text) > textMax ? "too_big" : { text, files };
}

function dataOf(contentType: string, body: string): Record<string, unknown> | null {
  try {
    if (contentType === "application/json") {
      const v = JSON.parse(body) as unknown;
      return v !== null && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
    }
    if (contentType === "application/x-www-form-urlencoded") {
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of new URLSearchParams(body)) if (!(k in out)) out[k] = v;
      return { ...out };
    }
  } catch {
    /* not data */
  }
  return null;
}

async function handle(
  request: Request,
  context: { params: Promise<{ plugin: string; route: string }> },
  method: "GET" | "POST",
): Promise<Response> {
  const { plugin, route } = await context.params;
  let host: Awaited<ReturnType<typeof pluginHost>>;
  try {
    host = await pluginHost();
  } catch {
    return fail(404, "There is nothing at this address.");
  }
  const info = host.routeInfo(plugin, route);
  if (!info) return fail(404, "There is nothing at this address.");
  if (info.method !== method) return fail(405, "This address does not take this kind of request.");
  if (method === "POST" && !isSameOrigin(request))
    return fail(403, "This request came from another address.");
  const who = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (tooOften(`${plugin}\n${who}`)) return fail(429, "Too many requests. Try again in a minute.");
  let user: RouteRequest["user"];
  if (info.signedIn) {
    const member = await signedInMember();
    if (!member) return fail(401, "Sign in first.");
    user = { id: member.user.id };
  }
  const max = Math.min(info.maxBytes ?? ROUTE_BODY_DEFAULT, ROUTE_BODY_MOST);
  let contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  let body: string | null;
  let sent: MultipartForm | null = null;
  // Files are taken only for a route that declared uploads and a plugin the owner approved `files:private` for.
  const uploads = host.allowed(plugin, "files:private") ? info.uploads : undefined;
  if (method === "POST" && uploads && contentType === "multipart/form-data") {
    const read = await readMultipart(request, max, uploads);
    if (read === "too_big") return fail(413, "This request is too big.");
    if (read === "bad") return fail(400, "The form could not be read.");
    sent = read;
    // The plugin reads the answers as it would from any form; the files come as references.
    body = read.text;
    contentType = "application/x-www-form-urlencoded";
  } else body = method === "POST" ? await readLimited(request, max) : "";
  if (body === null) return fail(413, "This request is too big.");
  let files: RouteFile[] | undefined;
  if (sent && uploads && sent.files.length > 0) {
    const extensionId = host.extensionOf(plugin);
    const stored = extensionId
      ? await receiveFiles(getRunner(), extensionId, uploads, sent.files)
      : ({ ok: false, message: "Files cannot be received now." } as const);
    if (!stored.ok)
      return new NextResponse(pageHtml("Please check your files", stored.message, true), {
        status: 400,
        headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" },
      });
    files = stored.files;
  }
  const query: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of new URL(request.url).searchParams) {
    if (count++ >= 50) break;
    if (!(k in query)) query[k] = v.slice(0, 2000);
  }
  const answer = await host.runRoute(plugin, route, {
    method,
    query,
    body,
    data: dataOf(contentType, body),
    contentType,
    ...(user ? { user } : {}),
    ...(files ? { files } : {}),
  });
  if (!answer.ok) return fail(answer.status, answer.message);
  const reply = answer.reply;
  if (reply.redirect !== undefined)
    return new NextResponse(null, {
      status: 303,
      headers: { ...HEADERS, location: reply.redirect },
    });
  if (reply.page !== undefined)
    return new NextResponse(pageHtml(reply.page.title, reply.page.text, reply.status >= 400), {
      status: reply.status,
      headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" },
    });
  if (reply.text !== undefined)
    return new NextResponse(reply.text, {
      status: reply.status,
      headers: {
        ...HEADERS,
        "content-type":
          reply.textType === "calendar"
            ? "text/calendar; charset=utf-8"
            : "text/plain; charset=utf-8",
      },
    });
  return NextResponse.json(reply.json ?? null, { status: reply.status, headers: HEADERS });
}

type Context = { params: Promise<{ plugin: string; route: string }> };
export const GET = (request: Request, context: Context) => handle(request, context, "GET");
export const POST = (request: Request, context: Context) => handle(request, context, "POST");
