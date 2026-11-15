// The address the site is reached at: OKS_SITE_URL when it is set, otherwise the address of this request.
import { headers } from "next/headers";

export async function siteBase(): Promise<string> {
  const set = process.env["OKS_SITE_URL"];
  if (set) return set;
  const head = await headers();
  return `${head.get("x-forwarded-proto") ?? "http"}://${head.get("host") ?? "localhost"}`;
}
