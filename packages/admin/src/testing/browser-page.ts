// Test helper: bundles a small React page with the real oks-ui and serves it, so tests can drive it in Chromium.
import { build } from "esbuild";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const src = join(import.meta.dirname, "..");

export const browserPath = [
  process.env["CHROMIUM_PATH"],
  "/opt/pw-browsers/chromium",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].find((p): p is string => typeof p === "string" && existsSync(p));

export interface TestSite {
  base: string;
  browser: Browser;
  /** A page at the given width (and colour scheme), already loaded and showing an h1. */
  open(
    width: number,
    colorScheme?: "light" | "dark",
    search?: string,
    /** Runs on the new page before it loads, for example to expose a function the page calls. */
    before?: (page: Page) => Promise<void>,
  ): Promise<{ page: Page; errors: string[] }>;
  close(): Promise<void>;
}

/** `body` is the page's React code. `Shell`, `ListTable` and the oks-ui exports are in scope by import. */
export async function startTestSite(entryBody: string): Promise<TestSite> {
  const dir = mkdtempSync(join(tmpdir(), "oks-page-"));
  // A name of its own: test files run at the same time and must not overwrite each other's entry.
  const entry = join(
    src,
    "..",
    `page-entry-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp.tsx`,
  );
  writeFileSync(
    entry,
    `import { createRoot } from "react-dom/client";
import "oks-ui/styles.css";
import "${join(src, "shell.css")}";
import { Shell } from "${join(src, "shell.tsx")}";
import { ListTable } from "${join(src, "list-table.tsx")}";
import { EntryEditor } from "${join(src, "entry-editor.tsx")}";
${entryBody}`,
  );
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
        react: join(src, "..", "node_modules", "react"),
        "react-dom": join(src, "..", "node_modules", "react-dom"),
      },
      logLevel: "silent",
    });
  } finally {
    rmSync(entry, { force: true });
  }
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
  );
  const server: Server = createServer((req, res) => {
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
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ executablePath: browserPath! });
  return {
    base,
    browser,
    async open(width, colorScheme = "light", search = "", before) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, colorScheme });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await before?.(page);
      await page.goto(base + search);
      await page.waitForSelector("h1");
      // No transitions or animations: a colour that is still fading fails an axe contrast check on a slow machine.
      await page.addStyleTag({
        content:
          "*, *::before, *::after { transition: none !important; animation: none !important; }",
      });
      // oks-ui switches to dark through this attribute, not through the browser setting.
      if (colorScheme === "dark")
        await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      return { page, errors };
    },
    async close() {
      await browser.close();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
