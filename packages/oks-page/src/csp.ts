// The content security policy (spec 05, section 5, TH-49). The first part is the same for every answer and is set by
// next.ts. The rule about stylesheets depends on the hosts an administrator named (Settings > Security), so the
// proxy writes the whole policy for public pages. Nothing here imports another file of the package, so next.ts, which
// Node loads before the build, can use it.

/** Where a page may be framed, which address it is based on, where forms may send data, and no plug-in objects. */
export const BASE_POLICY =
  "base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'";

/** Where a browser sends a report when it refuses a stylesheet (ADR 0038: the admin says which host was blocked). */
export const REPORT_PATH = "/api/csp-report";

/** The policy of a public page: the base rules, the rule about stylesheets, and where refusals are reported. */
export function publicPolicy(styleRule: string): string {
  return `${BASE_POLICY}; ${styleRule}; report-uri ${REPORT_PATH}`;
}
