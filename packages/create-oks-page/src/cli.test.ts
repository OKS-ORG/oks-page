// The installer: what it asks, what it writes, and what it refuses.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { main, type Io } from "./cli.js";
import { EXPORT_REMOVED, generateProject, newSecret, PRODUCT, projectFiles } from "./generate.js";
import { complete, detectPackageManager, parseArgs, UsageError } from "./options.js";

describe("the options", () => {
  test("flags are read, and the defaults are SQLite, local uploads and installing", () => {
    expect(parseArgs(["my-site", "--db", "sqlite", "--yes"])).toEqual({
      dir: "my-site",
      database: "sqlite",
      yes: true,
    });
    expect(complete(parseArgs(["my-site"]), "pnpm/10.28.0 npm/? node/v22")).toEqual({
      dir: "my-site",
      database: "sqlite",
      storage: "local",
      packageManager: "pnpm",
      install: true,
      workspace: false,
    });
  });

  test("the package manager comes from the user agent, and falls back to npm", () => {
    expect(detectPackageManager("yarn/4.1.0 npm/? node/v22.0.0")).toBe("yarn");
    expect(detectPackageManager("bun/1.2 npm/? node/v22")).toBe("npm");
    expect(detectPackageManager(undefined)).toBe("npm");
  });

  test("wrong answers are refused with a plain message", () => {
    const refused = (args: string[]) => {
      try {
        complete(parseArgs(args));
      } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
        return (error as Error).message;
      }
      throw new Error("was not refused");
    };
    expect(refused([])).toMatch(/Give the folder/);
    expect(refused(["a", "--db", "mysql"])).toMatch(/--db must be one of: sqlite, postgres/);
    expect(refused(["a", "--db", "postgres"])).toMatch(/needs --database-url/);
    expect(refused(["a", "--db", "postgres", "--database-url", "mysql://x"])).toMatch(
      /must start with postgres/,
    );
    expect(refused(["a", "--storage", "s3"])).toMatch(/--storage must be one of: local/);
    expect(refused(["a", "b"])).toMatch(/Only one folder name/);
    expect(refused(["a", "--nope"])).toMatch(/Unknown option --nope/);
    expect(refused(["a", "--db"])).toMatch(/--db needs a value/);
  });
});

describe("the project", () => {
  let base = "";
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "oks-create-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const options = (over = {}) =>
    complete({ dir: join(base, "My Site"), yes: true, ...over }, "pnpm/10.28.0");

  test("no file is listed twice in a project", () => {
    const paths = projectFiles(options(), "x".repeat(40)).map((f) => f.path);
    const twice = paths.filter((path, i) => paths.indexOf(path) !== i);
    expect(twice).toEqual([]);
  });

  test("every file of a project is written, with a package name made from the folder", () => {
    const made = generateProject(options());
    expect(made.files).toEqual(
      expect.arrayContaining([
        "package.json",
        ".env",
        ".gitignore",
        "next.config.mjs",
        "proxy.ts",
        "instrumentation.ts",
        "app/layout.tsx",
        "app/[[...slug]]/page.tsx",
        "app/admin/setup/page.tsx",
        "app/admin/page.tsx",
        "app/admin/login/page.tsx",
        "app/admin/pages/page.tsx",
        "app/admin/posts/[id]/page.tsx",
        "app/api/admin/entries/[id]/route.ts",
        "app/api/setup/route.ts",
        "app/api/auth/[...all]/route.ts",
        "app/not-found-handler/route.ts",
        "data/.gitkeep",
        "uploads/.gitkeep",
      ]),
    );
    const pkg = JSON.parse(readFileSync(join(made.dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-site");
    expect(pkg.dependencies[PRODUCT]).toMatch(/^\^\d/);
    expect(pkg.dependencies.next).toBe("16.4.6");
    // pnpm 10 must be allowed to build the SQLite driver.
    expect(pkg.pnpm.onlyBuiltDependencies).toEqual(["better-sqlite3"]);
  });

  test("a project can export a static site: the export files, the build script and the command are there", () => {
    const files = Object.fromEntries(
      projectFiles(options(), "x".repeat(40)).map((f) => [f.path, f.content]),
    );
    expect(files["export/page.tsx"]).toContain(
      `export { default, generateMetadata, generateStaticParams } from "${PRODUCT}/site-export";`,
    );
    expect(JSON.parse(files["export/removed.json"]!)).toEqual(EXPORT_REMOVED);
    expect(files["scripts/build-export.mjs"]).toContain(
      `import { runExportBuild } from "${PRODUCT}/export-build";`,
    );
    const pkg = JSON.parse(files["package.json"]!);
    expect(pkg.scripts.export).toBe("oks export . --uploads uploads");
    expect(pkg.devDependencies[`@${PRODUCT}/cli`]).toMatch(/^\^\d/);
    // The list in a new project is the one this repository's own site uses, so what `oks export --check` reads is the same.
    const own = JSON.parse(
      readFileSync(new URL("../../../apps/site/export/removed.json", import.meta.url), "utf8"),
    );
    expect(own).toEqual(EXPORT_REMOVED);
  });

  test("the files only re-export from the package, and the proxy writes its own matcher", () => {
    const files = Object.fromEntries(
      projectFiles(options(), "x".repeat(40)).map((f) => [f.path, f.content]),
    );
    expect(files["app/layout.tsx"]).toBe(`export { default } from "${PRODUCT}/layout";\n`);
    expect(files["app/api/auth/[...all]/route.ts"]).toBe(
      `export { GET, POST } from "${PRODUCT}/api-auth";\n`,
    );
    expect(files["next.config.mjs"]).toContain(`import { withOksPage } from "${PRODUCT}/next";`);
    expect(files["proxy.ts"]).toContain("export const config = {");
    expect(files["proxy.ts"]).toContain(`export { proxy } from "${PRODUCT}/proxy";`);
  });

  test("each project gets its own secret key of at least 32 characters, and .env is not committed", () => {
    expect(newSecret()).not.toBe(newSecret());
    const a = readFileSync(
      join(generateProject(options({ dir: join(base, "a") })).dir, ".env"),
      "utf8",
    );
    const b = readFileSync(
      join(generateProject(options({ dir: join(base, "b") })).dir, ".env"),
      "utf8",
    );
    const secret = (env: string) => /^OKS_SECRET=(.+)$/m.exec(env)![1]!;
    expect(secret(a).length).toBeGreaterThanOrEqual(32);
    expect(secret(a)).not.toBe(secret(b));
    expect(readFileSync(join(base, "a", ".gitignore"), "utf8").split("\n")).toContain(".env");
  });

  test("SQLite writes the file path; PostgreSQL writes the URL", () => {
    const sqlite = readFileSync(
      join(generateProject(options({ dir: join(base, "s") })).dir, ".env"),
      "utf8",
    );
    expect(sqlite).toContain("OKS_SQLITE_PATH=./data/site.sqlite");
    expect(sqlite).not.toContain("OKS_DATABASE_URL");
    const pg = readFileSync(
      join(
        generateProject(
          options({
            dir: join(base, "p"),
            database: "postgres",
            databaseUrl: "postgres://u:p@h/db",
          }),
        ).dir,
        ".env",
      ),
      "utf8",
    );
    expect(pg).toContain("OKS_DATABASE_URL=postgres://u:p@h/db");
    expect(pg).not.toContain("OKS_SQLITE_PATH=");
  });

  test("a folder with files in it is refused and left as it was; an empty one is used", () => {
    const dir = join(base, "taken");
    mkdirSync(dir);
    writeFileSync(join(dir, "mine.txt"), "keep");
    expect(() => generateProject(options({ dir }))).toThrow(/is not empty/);
    expect(readFileSync(join(dir, "mine.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(dir, "package.json"))).toBe(false);
    const empty = join(base, "empty");
    mkdirSync(empty);
    expect(() => generateProject(options({ dir: empty }))).not.toThrow();
  });
});

describe("the command", () => {
  let base = "";
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "oks-cmd-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function terminal(answers: string[] = [], interactive = false) {
    const out: string[] = [];
    const asked: string[] = [];
    const ran: string[][] = [];
    const io: Io = {
      interactive,
      out: (text) => out.push(text),
      ask: async (question) => {
        asked.push(question);
        return answers.shift() ?? "";
      },
      run: (command, args) => {
        ran.push([command, ...args]);
        return true;
      },
    };
    return { io, out, asked, ran };
  }

  test("with --yes it asks nothing, writes the site, installs, and says what to do next", async () => {
    const t = terminal();
    const code = await main([join(base, "site"), "--yes"], t.io, "pnpm/10.28.0");
    expect(code).toBe(0);
    expect(t.asked).toEqual([]);
    expect(t.ran).toEqual([["pnpm", "install"]]);
    expect(existsSync(join(base, "site", "package.json"))).toBe(true);
    expect(t.out.join("\n")).toContain("http://localhost:3000/admin/setup");
    // The words of the design: a title, what was chosen, a tick for each thing done, then what to do next.
    const said = t.out.join("\n");
    expect(said).toContain("create a new site");
    expect(said).toContain("◇ Database        SQLite");
    expect(said).toContain("✓ Wrote .env with a new secret key");
    expect(said).toContain("✓ Installed everything with pnpm");
    expect(said).toContain("Next:\n   cd ");
    expect(said).not.toContain("\x1b[");
  });

  test("--no-install writes the files and tells the person to install", async () => {
    const t = terminal();
    expect(await main([join(base, "site"), "--no-install"], t.io, "npm/10 node/v22")).toBe(0);
    expect(t.ran).toEqual([]);
    expect(t.out.join("\n")).toContain("npm install");
  });

  test("on a terminal it asks for what the flags left out", async () => {
    const t = terminal([join(base, "asked"), "postgres", "postgres://u:p@h/db"], true);
    expect(await main(["--no-install"], t.io, "pnpm/10")).toBe(0);
    expect(t.asked).toHaveLength(3);
    expect(readFileSync(join(base, "asked", ".env"), "utf8")).toContain(
      "OKS_DATABASE_URL=postgres://u:p@h/db",
    );
  });

  test("a mistake is answered with the usage text and code 2; a taken folder with code 1", async () => {
    const bad = terminal();
    expect(await main(["x", "--db", "mysql"], bad.io)).toBe(2);
    expect(bad.out.join("\n")).toContain("Usage:");
    mkdirSync(join(base, "taken"));
    writeFileSync(join(base, "taken", "f"), "x");
    const taken = terminal();
    expect(await main([join(base, "taken"), "--yes"], taken.io)).toBe(1);
    expect(taken.out.join("\n")).toMatch(/is not empty/);
  });

  test("a failed install is reported, and the files stay", async () => {
    const t = terminal();
    t.io.run = () => false;
    expect(await main([join(base, "site"), "--yes"], t.io, "pnpm/10")).toBe(1);
    expect(t.out.join("\n")).toMatch(/install did not finish/);
    expect(existsSync(join(base, "site", ".env"))).toBe(true);
  });
});
