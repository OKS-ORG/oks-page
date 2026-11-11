// The public address of the site, for canonical links. (Later it is a setting; for now it comes from OKS_SITE_URL.)
export function canonicalFor(slug: string): string {
  const base = process.env["OKS_SITE_URL"] ?? "http://localhost:3000";
  return new URL(slug === "home" ? "/" : `/${slug}`, base).toString();
}
