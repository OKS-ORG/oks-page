import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { checkExport, formatExportCheck } from "./export-check.js";

const dirs: string[] = [];
function site(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "oks-export-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const codes = (dir: string, options = {}) => checkExport(dir, options).issues.map((i) => i.code);

describe("oks export preflight", () => {
  test("ST-30: a clean site passes", () => {
    const dir = site({
      "src/app/page.tsx": "export default function P() { return <img src='/a.png' />; }",
    });
    expect(checkExport(dir)).toEqual({ ok: true, issues: [] });
    expect(formatExportCheck(checkExport(dir))).toContain("No problems");
  });

  test("ST-30: a proxy file stops the export", () => {
    const dir = site({
      "src/proxy.ts": "export function proxy() {}",
      "src/app/page.tsx": "export default () => null;",
    });
    expect(codes(dir)).toEqual(["proxy-file"]);
    expect(checkExport(dir).ok).toBe(false);
  });

  test("ST-30: next/image with the default loader stops the export, and turning the optimiser off allows it", () => {
    const page = {
      "src/app/page.tsx":
        "import Image from 'next/image'; export default () => <Image src='/a.png' alt='' />;",
    };
    expect(codes(site(page))).toEqual(["image-default-loader"]);
    expect(
      codes(
        site({ ...page, "next.config.mjs": "export default { images: { unoptimized: true } };" }),
      ),
    ).toEqual([]);
  });

  test("ST-30: cookies, headers, Draft Mode and Server Actions stop the export", () => {
    const dir = site({
      "src/app/a/page.tsx":
        "import { cookies } from 'next/headers'; export default async () => (await cookies()).get('x');",
      "src/app/b/actions.ts": "'use server'; export async function save() {}",
    });
    expect(codes(dir).sort()).toEqual(["request-data", "server-action"]);
  });

  test("ST-30: pages that need a server (admin, api) are not part of the export", () => {
    const dir = site({
      "src/app/page.tsx": "export default () => null;",
      "src/app/admin/page.tsx":
        "import { cookies } from 'next/headers'; export default () => cookies();",
      "src/app/api/x/route.ts": "export function GET(r: Request) { return new Response(r.url); }",
    });
    expect(codes(dir)).toEqual([]);
  });

  test("ST-30: a changing address needs generateStaticParams, and a route handler needs force-static", () => {
    const dir = site({
      "src/app/[slug]/page.tsx": "export default () => null;",
      "src/app/feed/route.ts": "export function GET() { return new Response('x'); }",
      "src/app/sitemap/route.ts":
        "export const dynamic = 'force-static'; export function GET() { return new Response('x'); }",
    });
    expect(codes(dir).sort()).toEqual(["no-static-params", "route-not-static"]);
    const ok = site({
      "src/app/[slug]/page.tsx":
        "export function generateStaticParams() { return []; } export default () => null;",
    });
    expect(codes(ok)).toEqual([]);
  });

  test("ST-11: blocks that need a server are errors, helpers are notes, unknown blocks are errors", () => {
    const dir = site({ "src/app/page.tsx": "export default () => null;" });
    const blocks = { text: "yes", login: "no", form: "helper", mystery: undefined } as const;
    const result = checkExport(dir, { blocks });
    expect(result.issues.map((i) => `${i.level}:${i.code}`).sort()).toEqual([
      "error:block-needs-server",
      "error:block-unknown",
      "warning:block-needs-helper",
    ]);
    expect(
      checkExport(dir, { blocks, helpersSet: ["form"] })
        .issues.map((i) => i.code)
        .sort(),
    ).toEqual(["block-needs-server", "block-unknown"]);
  });
});
