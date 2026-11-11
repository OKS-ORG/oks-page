// The site's one Better Auth instance, made on first use from the same database as the pages (spec 02).
import { createAuth, type OksAuth } from "@oks-page/auth";
import { getDrizzle, getRunner } from "./db";

/** The header our auth wrapper reads for the client's address (the library's own forwarding headers are ignored). */
export const CLIENT_HEADER = "x-oks-client-ip";

const shared = globalThis as typeof globalThis & { __oksAuth?: OksAuth };

/**
 * The address the visitor used, from the request's own headers. Next.js gives `request.url` its own idea of the host
 * ("localhost"), and Better Auth then refuses a browser that came from another name for the same machine (403).
 */
export function requestOrigin(request: Request): string {
  const host = request.headers.get("host");
  if (!host) return new URL(request.url).origin;
  const proto =
    request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** `origin` is the address the visitor used; it is only used when `OKS_SITE_URL` is not set. */
export function getAuth(origin: string): OksAuth {
  if (shared.__oksAuth) return shared.__oksAuth;
  const secret = process.env["OKS_SECRET"];
  if (!secret || secret.length < 32)
    throw new Error(
      "OKS_SECRET is not set. It must be a secret of at least 32 characters (the installer writes one).",
    );
  shared.__oksAuth = createAuth({
    db: getDrizzle(),
    runner: getRunner(),
    secret,
    baseUrl: process.env["OKS_SITE_URL"] ?? origin,
  });
  return shared.__oksAuth;
}
