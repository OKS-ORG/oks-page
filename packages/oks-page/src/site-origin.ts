// The address the sitemap and robots.txt name: OKS_SITE_URL when it is set, else the one this request came to. (Kept apart
// from site-url.ts so the public pages and the static export do not load the sign-in code.)
import { requestOrigin } from "./auth";

export function siteOrigin(request: Request): string {
  const configured = process.env["OKS_SITE_URL"];
  return configured ? new URL(configured).origin : requestOrigin(request);
}
