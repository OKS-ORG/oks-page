// The installer end to end: it writes a project, the project builds, starts on an empty database (the tables are made at
// start) and the setup wizard works in a browser. The package manager's own install step is the one thing not run: the
// project sits inside this site's folder and finds the same node_modules.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { generateProject } from "../../../packages/create-oks-page/src/generate";
import { findBrowser, freePort, next, siteDir } from "./helpers";

describe.skipIf(!findBrowser())("a site made by the installer", () => {
  const dir = join(siteDir, `.e2e-generated-${process.pid}`);
  let server: ChildProcess;
  let log = "";
  let base = "";
  let browser: Browser;

  beforeAll(async () => {
    generateProject({
      dir,
      database: "sqlite",
      storage: "local",
      packageManager: "pnpm",
      install: false,
      workspace: true,
    });
    // `next build` needs no database: the tables are made when the server starts.
    execFileSync(process.execPath, [next, "build"], {
      cwd: dir,
      stdio: "pipe",
      env: { ...process.env, OKS_SQLITE_PATH: "" },
    });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env = { ...process.env };
    delete env["OKS_SQLITE_PATH"];
    delete env["OKS_DATABASE_URL"];
    server = spawn(process.execPath, [next, "start", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: dir,
      env: { ...env, NODE_ENV: "production" },
      stdio: "pipe",
    });
    server.stdout?.on("data", (d) => (log += d));
    server.stderr?.on("data", (d) => (log += d));
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(`${base}/not-found-handler`)).status === 404) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
      if (i === 149) throw new Error("The generated site did not start:\n" + log);
    }
    browser = await chromium.launch({ executablePath: findBrowser()! });
  }, 600_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the first start made the tables, and said so", () => {
    expect(log).toMatch(/\[oks\] Applied \d+ database migration/);
  });

  test("a new site sends its first visit to the wizard, and the wizard makes the site and signs the owner in", async () => {
    const first = await fetch(base + "/", { redirect: "manual" });
    expect(first.status).toBe(307);
    expect(new URL(first.headers.get("location")!, base).pathname).toBe("/admin/setup");

    const page = await browser.newPage();
    await page.goto(base + "/admin/setup");
    await page.getByLabel("Site name").fill("Made by the installer");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByLabel("Your name").fill("Anna");
    await page.getByLabel("Email").fill("anna@example.com");
    await page.getByLabel(/^Password/).fill("a-long-password");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Finish setup" }).click();
    await page.getByRole("heading", { name: "Your site is set up" }).waitFor();

    for (const [path, text] of [
      ["/", "This is your home page"],
      ["/about", "Tell visitors who you are"],
      ["/blog/hello-world", "This is your first post"],
    ] as const) {
      const response = await fetch(base + path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain(text);
    }
    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/get-session");
      return await response.text();
    });
    expect(JSON.parse(session).user.email).toBe("anna@example.com");
    await page.close();
  }, 120_000);

  test("the secret key in .env is what the site uses, and the database is the file in data/", () => {
    expect(readFileSync(join(dir, ".env"), "utf8")).toMatch(/^OKS_SECRET=\w{96}$/m);
    const files = execFileSync("ls", [join(dir, "data")], { encoding: "utf8" });
    expect(files).toContain("site.sqlite");
  });
});
