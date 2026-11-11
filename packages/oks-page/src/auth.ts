// The site's one Better Auth instance, made on first use from the same database as the pages (spec 02).
import { createAuth, type OksAuth } from "@oks-page/auth";
import { getDrizzle, getRunner } from "./db";

/** The header our auth wrapper reads for the client's address (the library's own forwarding headers are ignored). */
export const CLIENT_HEADER = "x-oks-client-ip";

const shared = globalThis as typeof globalThis & { __oksAuth?: OksAuth };

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
