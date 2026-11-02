import { describe, expect, test } from "vitest";
import { buildRedirectFiles, checkRedirect } from "./redirects.js";

describe("redirect files for an exported site", () => {
  test("ST-13: one list becomes _redirects, .htaccess and an HTML page at the old address", () => {
    const files = buildRedirectFiles([{ from: "/old", to: "/new/" }]);
    expect(files.redirectsFile).toBe("/old /new/ 301\n");
    expect(files.htaccess).toBe('Redirect 301 "/old" "/new/"\n');
    expect(files.pages).toHaveLength(1);
    expect(files.pages[0]!.path).toBe("old/index.html");
    expect(files.pages[0]!.html).toContain('<meta http-equiv="refresh" content="0; url=/new/">');
    expect(files.pages[0]!.html).toContain('<link rel="canonical" href="/new/">');
    expect(files.pages[0]!.html).toContain('<meta name="robots" content="noindex">');
    expect(files.refused).toEqual([]);
  });

  test("ST-13: another status is written in every output", () => {
    const files = buildRedirectFiles([{ from: "/a", to: "/b/", status: 302 }]);
    expect(files.redirectsFile).toBe("/a /b/ 302\n");
    expect(files.htaccess).toBe('Redirect 302 "/a" "/b/"\n');
  });

  test("ST-14: thirteen hostile addresses are refused", () => {
    const hostile = [
      { from: "/old\n/evil /x 301", to: "/new/" },
      { from: "/old", to: "/new/\n/evil /x 301" },
      { from: "/old", to: "//evil.com" },
      { from: "/old", to: "javascript:alert(1)" },
      { from: "/old", to: "data:text/html,<script>1</script>" },
      { from: "/old/*", to: "/new/" },
      { from: "/old/:id", to: "/new/:id" },
      { from: "/old!", to: "/new/" },
      { from: '/old"; Redirect 301 "/x', to: "/new/" },
      { from: "/old page", to: "/new/" },
      { from: "old", to: "/new/" },
      { from: "//old", to: "/new/" },
      { from: "/old", to: '/new/" onload="x' },
    ];
    expect(hostile).toHaveLength(13);
    const files = buildRedirectFiles(hostile);
    expect(files.refused).toHaveLength(13);
    expect(files.redirectsFile).toBe("");
    expect(files.htaccess).toBe("");
    expect(files.pages).toEqual([]);
    for (const r of files.refused) expect(r.reason.length).toBeGreaterThan(10);
  });

  test("ST-15: accented paths and https targets are allowed", () => {
    const files = buildRedirectFiles([
      { from: "/über-uns", to: "/about/" },
      { from: "/blog/2020/post", to: "https://example.org/new/" },
    ]);
    expect(files.refused).toEqual([]);
    expect(files.redirectsFile).toContain("/über-uns /about/ 301");
    expect(files.redirectsFile).toContain("/blog/2020/post https://example.org/new/ 301");
  });

  test("ST-16: addresses are escaped in the redirect page", () => {
    const files = buildRedirectFiles([{ from: "/old", to: "https://example.org/?a=1&b=2" }]);
    expect(files.pages[0]!.html).toContain("https://example.org/?a=1&amp;b=2");
    expect(files.pages[0]!.html).not.toContain("a=1&b=2");
  });

  test("ST-17: an old address with a file name keeps it; a repeated or looping redirect is refused", () => {
    const files = buildRedirectFiles([
      { from: "/feed.xml", to: "/feed/" },
      { from: "/a", to: "/b/" },
      { from: "/a", to: "/c/" },
      { from: "/same", to: "/same" },
    ]);
    expect(files.pages.map((p) => p.path)).toEqual(["feed.xml", "a/index.html"]);
    expect(files.refused.map((r) => r.redirect.to)).toEqual(["/c/", "/same"]);
    expect(checkRedirect({ from: "/ok", to: "/fine/" })).toBeNull();
  });
});
