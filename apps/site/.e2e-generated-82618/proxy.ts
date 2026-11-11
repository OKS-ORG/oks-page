export { proxy } from "oks-page/proxy";
// Next.js reads the matcher while it builds, so it is written out here and not re-exported.
export const config = {
  matcher: [
    "/((?!api|admin|_next|robots.txt|sitemap.xml|not-found-handler|test-form|favicon.ico).*)",
  ],
};
