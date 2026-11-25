// Shared by the site tests: building the app, starting it, and putting data in the database.
import type { TestDb } from "@oks-page/db/testing";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";

export const siteDir = join(import.meta.dirname, "..");
export const next = join(siteDir, "node_modules", "next", "dist", "bin", "next");
export const T = new Date(1_700_000_000_000);

/** One build serves both databases: the pages read the database only when they are asked for. OKS_REUSE_BUILD=1 keeps an existing build. */
export function buildSite() {
  if (process.env["OKS_REUSE_BUILD"] && existsSync(join(siteDir, ".next", "BUILD_ID"))) return;
  execFileSync(process.execPath, [next, "build"], {
    cwd: siteDir,
    env: { ...process.env, OKS_SQLITE_PATH: "/nonexistent", OKS_BUILD: "" },
    stdio: "pipe",
  });
}

export const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

export async function startSite(kind: string, db: TestDb, extra: Record<string, string> = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OKS_TEST: "1",
    // The tests never ask YouTube or Vimeo for a picture (PB-94 has its own tests with a fake network).
    OKS_VIDEO_COVERS: "off",
    PORT: String(port),
    NODE_ENV: "production",
    // Backups of a test site go to a folder of their own, never into the project.
    OKS_BACKUP_DIR: mkdtempSync(join(tmpdir(), "oks-backups-")),
    ...Object.fromEntries(
      Object.entries(extra).map(([k, v]) => [k, v.replaceAll("{port}", String(port))]),
    ),
  };
  if (kind === "sqlite") env["OKS_SQLITE_PATH"] = db.location;
  else {
    env["OKS_DATABASE_URL"] = process.env["DATABASE_URL"]!;
    env["OKS_PG_SEARCH_PATH"] = db.location;
  }
  const server = spawn(process.execPath, [next, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: siteDir,
    env,
    stdio: "pipe",
  });
  let log = "";
  server.stdout?.on("data", (d) => (log += d));
  server.stderr?.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/not-found-handler`)).status === 404)
        return { server, base, port, log: () => log };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  server.kill();
  throw new Error("The site did not start:\n" + log);
}

export async function seed(db: TestDb) {
  const site = "SITE0000000000000000000001";
  const user = "USER0000000000000000000001";
  await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
    site,
    T,
    T,
  ]);
  await db.run(
    "insert into users (id, name, email, created_at, updated_at) values (?, 'U', 'u@example.com', ?, ?)",
    [user, T, T],
  );
  let n = 0;
  const entry = async (slug: string, title: string, status = "published", type = "page") => {
    const id = `ENT${String(++n).padStart(23, "0")}`;
    await db.run(
      "insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, plain_text, html, seo, meta, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, '{}', '[]', ?, ?, '{}', '{}', ?, ?)",
      [id, site, type, status, title, slug, user, title, `<p>${title} body</p>`, T, T],
    );
    return id;
  };
  return { site, user, entry };
}

/** The export build (static mode) of the site, written to `out`, reading the given database. */
export function buildExport(
  kind: string,
  db: TestDb,
  out: string,
  extra: Record<string, string> = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (kind === "sqlite") env["OKS_SQLITE_PATH"] = db.location;
  else {
    env["OKS_DATABASE_URL"] = process.env["DATABASE_URL"]!;
    env["OKS_PG_SEARCH_PATH"] = db.location;
  }
  execFileSync(process.execPath, [join(siteDir, "scripts", "build-export.mjs"), out], {
    cwd: siteDir,
    env,
    stdio: "pipe",
  });
}

/** A Chrome or Chromium to drive, or null. In CI one must exist. */
export function findBrowser(): string | null {
  const candidates = [
    process.env["CHROMIUM_PATH"],
    "/opt/pw-browsers/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((p): p is string => typeof p === "string" && existsSync(p)) ?? null;
}
