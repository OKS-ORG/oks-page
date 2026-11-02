// The admin shell in a real browser (AD-01 to AD-09, AD-14): the shell is bundled with the real oks-ui and driven in Chromium.
import axe from "axe-core";
import { build } from "esbuild";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const here = import.meta.dirname;
const browserPath = [
  process.env["CHROMIUM_PATH"],
  "/opt/pw-browsers/chromium",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].find((p): p is string => typeof p === "string" && existsSync(p));

const ENTRY = `
import { createRoot } from "react-dom/client";
import { Table } from "oks-ui";
import "oks-ui/styles.css";
import "${join(here, "shell.css")}";
import { Shell } from "${join(here, "shell.tsx")}";
const nav = [
  { key: "dashboard", label: "Dashboard", href: "#dashboard" },
  { key: "pages", label: "Pages", href: "#pages" },
  { key: "plugins", label: "Plugins (2 new)", href: "#plugins" },
];
const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, title: "Page " + i + " with a fairly long title to push the table wider", status: "Published" }));
createRoot(document.getElementById("root")).render(
  <Shell nav={nav} selectedKey="pages" title="Pages" breadcrumbs={[{ label: "Home", href: "#dashboard" }, { label: "Pages" }]}
    searchItems={[{ id: "plugins", label: "Plugins", href: "#plugins" }]} onNavigate={(h) => { location.hash = h; }}>
    <Table aria-label="Pages" columns={[{ key: "title", header: "Title" }, { key: "status", header: "Status" }]} rows={rows} getRowKey={(r) => r.id} />
  </Shell>);
`;

let dir = "";
let server: Server;
let base = "";
let browser: Browser;

beforeAll(async () => {
  if (!browserPath) return;
  dir = mkdtempSync(join(tmpdir(), "oks-shell-"));
  const entry = join(here, "..", "shell-entry.tmp.tsx");
  writeFileSync(entry, ENTRY);
  try {
    await build({
      entryPoints: [entry],
      outfile: join(dir, "app.js"),
      bundle: true,
      format: "iife",
      jsx: "automatic",
      loader: { ".css": "css" },
      define: { "process.env.NODE_ENV": '"production"' },
      // One copy of React (AD-47).
      alias: {
        react: join(here, "..", "node_modules", "react"),
        "react-dom": join(here, "..", "node_modules", "react-dom"),
      },
      logLevel: "silent",
    });
  } finally {
    rmSync(entry, { force: true });
  }
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pages</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
  );
  server = createServer((req, res) => {
    const name = req.url === "/app.js" || req.url === "/app.css" ? req.url : "/index.html";
    const type = name.endsWith(".js")
      ? "text/javascript"
      : name.endsWith(".css")
        ? "text/css"
        : "text/html";
    res.setHeader("content-type", type);
    res.end(readFileSync(join(dir, name)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: browserPath });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function open(
  width: number,
  colorScheme: "light" | "dark" = "light",
): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 800 }, colorScheme });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForSelector("h1");
  // oks-ui switches to dark through this attribute, not through the browser setting.
  if (colorScheme === "dark")
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  return { page, errors };
}

describe.skipIf(!browserPath)("the admin shell", () => {
  test("AD-01, AD-14: no sideways page scroll at 1280, 1024, 768, 390 and 320 px, and no page errors", async () => {
    for (const width of [1280, 1024, 768, 390, 320]) {
      const { page, errors } = await open(width);
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(sideways, `${width}px`).toBe(false);
      expect(errors).toEqual([]);
      await page.close();
    }
  });

  test("AD-02: the sidebar shows at 1025 px and above; a Menu button below", async () => {
    const wide = await open(1025);
    expect(await wide.page.locator("aside nav").count()).toBe(1);
    expect(await wide.page.getByRole("button", { name: "Menu" }).count()).toBe(0);
    await wide.page.close();
    const narrow = await open(1024);
    expect(await narrow.page.locator("aside").count()).toBe(0);
    expect(await narrow.page.getByRole("button", { name: "Menu" }).count()).toBe(1);
    await narrow.page.close();
  });

  test("AD-04, AD-05: the drawer is a dialog with the menu, and Escape returns focus to the Menu button", async () => {
    const { page } = await open(390);
    await page.getByRole("button", { name: "Menu" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    expect(await dialog.getByRole("link", { name: "Dashboard" }).count()).toBe(1);
    expect(
      await page.evaluate(() => document.activeElement?.closest("[role=dialog]") !== null),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Menu");
    await page.close();
  });

  test("AD-06, AD-07: Ctrl+K opens the search, typing and Enter go to the item", async () => {
    const { page } = await open(1280);
    await page.keyboard.press("Control+k");
    const box = page.getByRole("combobox");
    await box.waitFor();
    await box.fill("plug");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => location.hash)).toBe("#plugins");
    await page.close();
  });

  test("AD-08, AD-09: Skip to content is the first Tab stop and moves focus to the main area", async () => {
    const { page } = await open(1280);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Skip to content");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("main");
    await page.close();
  });

  test("AD-03: axe finds no violation at 1280, 1024, 768, 390 and 320 px, in light and dark", async () => {
    for (const scheme of ["light", "dark"] as const) {
      for (const width of [1280, 1024, 768, 390, 320]) {
        const { page } = await open(width, scheme);
        await page.addScriptTag({ content: axe.source });
        const result = await page.evaluate(() =>
          (window as unknown as { axe: typeof axe }).axe.run(document, {
            runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
          }),
        );
        expect(
          result.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
          ),
          `${scheme} ${width}px`,
        ).toEqual([]);
        await page.close();
      }
    }
  }, 60_000);
});
