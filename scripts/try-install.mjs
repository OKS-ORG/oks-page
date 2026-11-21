// Tries what an outsider would do, without npm: packs every package, makes a project with the installer, installs it
// with npm from the packed files, builds it, starts it, runs the setup wizard in a browser, exports the site and
// publishes it to a folder.
//
//   node scripts/try-install.mjs [--keep]       the folder is printed; it is removed at the end unless --keep
//
// It needs a built repository (pnpm build), the dependencies from the npm registry and a Chromium (CHROMIUM_PATH).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const { product } = JSON.parse(readFileSync(join(root, "brand.json"), "utf8"));
const { fetch } = globalThis;
const sleep = (ms) => new Promise((done) => globalThis.setTimeout(done, ms));
const keep = process.argv.includes("--keep");
const work = mkdtempSync(join(tmpdir(), "oks-try-install-"));
const packs = join(work, "packs");
const project = join(work, "site");
const say = (text) => console.log(`[try-install] ${text}`);
const sh = (cmd, args, cwd, env = {}) =>
  execFileSync(cmd, args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });

let server;
let browser;
try {
  say("packing every package");
  sh(process.execPath, ["scripts/release.mjs", "--pack", "--out", packs], root);
  const files = readdirSync(packs);

  say("making a project with the installer");
  sh(
    process.execPath,
    [
      join(root, "packages/create-oks-page/dist/bin.js"),
      project,
      "--no-install",
      "--yes",
      "--package-manager",
      "npm",
    ],
    root,
  );
  const pkgFile = join(project, "package.json");
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  // The packages are not on npm yet: every package of this product comes from the packed files.
  const overrides = {};
  for (const file of files) {
    const base = file.replace(/-\d+\.\d+\.\d+.*\.tgz$/, "");
    if (base.startsWith("create-")) continue;
    overrides[base === product ? base : `@${product}/${base.replace(`${product}-`, "")}`] =
      `file:${join(packs, file)}`;
  }
  pkg.overrides = overrides;
  for (const section of ["dependencies", "devDependencies"]) {
    for (const key of Object.keys(pkg[section] ?? {}))
      if (overrides[key]) pkg[section][key] = overrides[key];
  }
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));

  say("npm install (this takes a few minutes)");
  sh("npm", ["install", "--no-audit", "--no-fund"], project);
  say("next build");
  sh("npm", ["run", "build"], project);

  const port = 4100 + (process.pid % 800);
  const base = `http://127.0.0.1:${port}`;
  let log = "";
  // Next.js itself, not through npm: killing npm would leave the server running.
  const nextBin = join(project, "node_modules", "next", "dist", "bin", "next");
  server = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: project,
    stdio: "pipe",
  });
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/not-found-handler`)).status === 404) break;
    } catch {
      /* not up yet */
    }
    if (i > 200) throw new Error(`the site did not start:\n${log}`);
    await sleep(200);
  }
  if (!/\[oks\] Applied \d+ database migration/.test(log))
    throw new Error(`the first start did not make the tables:\n${log}`);

  say("setup wizard in a browser");
  const { chromium } = createRequire(join(root, "apps/site/package.json"))("playwright-core");
  const executablePath =
    process.env["CHROMIUM_PATH"] ??
    ["/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
  browser = await chromium.launch({ executablePath });
  const page = await browser.newPage();
  await page.goto(base + "/admin/setup");
  await page.getByLabel("Site name").fill("Installed from packed files");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByLabel("Your name").fill("Anna");
  await page.getByLabel("Email").fill("anna@example.com");
  await page.getByLabel(/^Password/).fill("a-long-password");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await page.getByRole("heading", { name: "Your site is set up" }).waitFor();
  const home = await (await fetch(base + "/")).text();
  if (!home.includes("This is your home page"))
    throw new Error("the home page does not show the starter text");
  await page.goto(base + "/admin");
  await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
  await browser.close();
  browser = undefined;
  server.kill();
  server = undefined;

  say("oks export and oks publish");
  const out = join(work, "out");
  const live = join(work, "live");
  sh("npx", ["oks", "export", ".", "--out", out, "--uploads", "uploads"], project);
  for (const [path, text] of [
    ["index.html", "This is your home page"],
    ["about.html", "Tell visitors who you are"],
    ["blog/hello-world.html", "This is your first post"],
  ]) {
    if (!readFileSync(join(out, path), "utf8").includes(text))
      throw new Error(`${path} is missing "${text}"`);
  }
  const published = sh("npx", ["oks", "publish", out, "--folder", live], project);
  if (!/Published: \d+ files sent/.test(published)) throw new Error(`publish said: ${published}`);
  say("DONE: install, build, start, setup, export and publish all worked from the packed files.");
} finally {
  await browser?.close();
  server?.kill();
  if (keep) say(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
