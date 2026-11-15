// The site's one Better Auth instance, made on first use from the same database as the pages (spec 02).
import { createAuth, type OksAuth } from "@oks-page/auth";
import {
  emailWorks,
  loadGeneralSettings,
  recordPasskeyChange,
  sendAccountChangeEmail,
  sendAddressLinkEmail,
  sendNewDeviceEmail,
  sendPasswordResetEmail,
  sendSignInLinkEmail,
} from "@oks-page/core";
import { getDrizzle, getRunner, getSiteId } from "./db";
import { kickEmailJobs, siteSecrets } from "./mail";
import { passkeyOptions } from "./passkey-options";

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
  const baseUrl = process.env["OKS_SITE_URL"] ?? origin;
  const site = new URL(baseUrl).origin;
  const siteName = async (siteId: string) =>
    (await loadGeneralSettings(getRunner(), siteId)).siteName;
  shared.__oksAuth = createAuth({
    db: getDrizzle(),
    runner: getRunner(),
    secret,
    baseUrl,
    ...(passkeyOptions(baseUrl) ? { passkey: passkeyOptions(baseUrl)! } : {}),
    onPasskeyChange: async ({ userId, change, name }) => {
      await recordPasskeyChange(getRunner(), await getSiteId(), userId, change, name);
    },
    // Password reset and the security emails (spec 13). When email is not set up, nothing is queued.
    sendResetPassword: async ({ email, name, token }) => {
      const siteId = await getSiteId();
      const sent = await sendPasswordResetEmail(getRunner(), siteId, siteSecrets(), {
        to: email,
        name,
        siteName: await siteName(siteId),
        link: `${site}/admin/reset-password?token=${encodeURIComponent(token)}`,
      });
      if (sent.sent) kickEmailJobs();
    },
    onAccountChange: async ({ email, name, change, previous, address }) => {
      const siteId = await getSiteId();
      const sent = await sendAccountChangeEmail(getRunner(), siteId, siteSecrets(), {
        to: email,
        name,
        siteName: await siteName(siteId),
        change,
        accountLink: `${site}/admin/account`,
        ...(previous ? { previous } : {}),
        ...(address ? { address } : {}),
      });
      if (sent.sent) kickEmailJobs();
    },
    // Confirming and changing an email address (spec 13, section 5); only while email works (EM-02).
    sendAddressLink: async ({ email, name, kind, url, address }) => {
      const siteId = await getSiteId();
      const sent = await sendAddressLinkEmail(getRunner(), siteId, siteSecrets(), {
        kind,
        to: email,
        name,
        siteName: await siteName(siteId),
        link: url,
        ...(address ? { address } : {}),
      });
      if (sent.sent) kickEmailJobs();
    },
    emailReady: async () => emailWorks(getRunner(), await getSiteId()),
    // Sign-in links (spec 13, section 5): only for a confirmed address without two-factor; otherwise the reason.
    sendSignInLink: async (data) => {
      const siteId = await getSiteId();
      const common = {
        to: data.email,
        name: data.name,
        siteName: await siteName(siteId),
        loginLink: `${site}/admin/login`,
      };
      const sent = await sendSignInLinkEmail(
        getRunner(),
        siteId,
        siteSecrets(),
        "url" in data ? { ...common, link: data.url } : { ...common, refused: data.refused },
      );
      if (sent.sent) kickEmailJobs();
    },
    onNewDevice: async ({ email, name, when, browser, address }) => {
      const siteId = await getSiteId();
      const sent = await sendNewDeviceEmail(getRunner(), siteId, siteSecrets(), {
        to: email,
        name,
        siteName: await siteName(siteId),
        when,
        browser,
        address,
        accountLink: `${site}/admin/account`,
      });
      if (sent.sent) kickEmailJobs();
    },
  });
  return shared.__oksAuth;
}
