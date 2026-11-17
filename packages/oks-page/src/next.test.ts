import { describe, expect, test } from "vitest";
import { SECURITY_HEADERS, withOksPage } from "./next.js";

const header = (key: string) => SECURITY_HEADERS.find((h) => h.key === key)?.value ?? "";

describe("the rules every answer carries", () => {
  test("the content security policy decides framing, base address, forms and plug-in objects, and says nothing about scripts or styles", () => {
    const policy = header("Content-Security-Policy");
    expect(policy).toContain("frame-ancestors 'self'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("form-action 'self'");
    // Scripts and styles are not in this step: a rule here could stop a page from running.
    expect(policy).not.toMatch(/script-src|style-src|default-src/);
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(header("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  test("the config carries them on every address except the upload and font files, and the admin and API still are never stored", async () => {
    const rules = await withOksPage({}).headers!();
    const everywhere = rules.find((r) =>
      r.headers.some((h) => h.key === "Content-Security-Policy"),
    )!;
    expect(everywhere.headers).toEqual(SECURITY_HEADERS);
    // The files set their own, stricter policy, so these are left out of the rule.
    const pattern = new RegExp(`^${everywhere.source.replace(/^\//, "/")}$`);
    expect(pattern.test("/uploads/a.png")).toBe(false);
    expect(pattern.test("/fonts/inter.woff2")).toBe(false);
    expect(pattern.test("/_next/static/x.js")).toBe(false);
    expect(pattern.test("/")).toBe(true);
    expect(pattern.test("/blog/hello")).toBe(true);
    expect(pattern.test("/admin/pages")).toBe(true);
    expect(pattern.test("/api/admin/entries")).toBe(true);
    const admin = rules.find((r) => r.source === "/admin/:path*")!;
    expect(admin.headers).toEqual([{ key: "Cache-Control", value: "private, no-store" }]);
  });

  test("a project's own header rules still follow", async () => {
    const rules = await withOksPage({
      headers: async () => [{ source: "/x", headers: [{ key: "X-Mine", value: "1" }] }],
    }).headers!();
    expect(rules.at(-1)).toEqual({ source: "/x", headers: [{ key: "X-Mine", value: "1" }] });
  });

  test("an export build has no server, so no header rules", () => {
    process.env["OKS_BUILD"] = "export";
    try {
      expect(withOksPage({}).headers).toBeUndefined();
    } finally {
      delete process.env["OKS_BUILD"];
    }
  });
});
