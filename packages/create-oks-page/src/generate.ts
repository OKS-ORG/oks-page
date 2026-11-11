// Writes a new project: the few small files that re-export the site, the admin and the API from the package
// (architecture overview, "What a site project looks like").
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { InstallOptions } from "./options.js";

const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};
/** The package this installer installs: its own name without the "create-" in front. */
export const PRODUCT = own.name.replace(/^create-/, "");
const NEXT = "16.4.2";
const REACT = "19.3.1";

export class FolderNotEmptyError extends Error {}

/** A name that is allowed in a package.json: lower case letters, digits and hyphens. */
export const packageNameOf = (dir: string): string =>
  basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "site";

export interface ProjectFile {
  path: string;
  content: string;
}

/** The files of a project, as data, so tests can read them without writing anything. */
export function projectFiles(options: InstallOptions, secret: string): ProjectFile[] {
  const from = (part: string) => `"${PRODUCT}/${part}"`;
  const packageJson = {
    name: packageNameOf(options.dir),
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: { dev: "next dev", build: "next build", start: "next start" },
    // pnpm 10 does not run install scripts unless they are allowed: without this the SQLite driver is never built.
    pnpm: { onlyBuiltDependencies: ["better-sqlite3"] },
    dependencies: {
      next: NEXT,
      [PRODUCT]: options.workspace ? "workspace:*" : `^${own.version}`,
      react: REACT,
      "react-dom": REACT,
    },
    devDependencies: {
      "@types/node": "^22.20.5",
      "@types/react": "^19.3.0",
      typescript: "~5.9.3",
    },
  };
  const env = [
    "# The secret key of this site. Keep it private and never commit this file.",
    `OKS_SECRET=${secret}`,
    "",
    options.database === "sqlite"
      ? "# SQLite: the database is this file."
      : "# PostgreSQL: the connection URL.",
    options.database === "sqlite"
      ? "OKS_SQLITE_PATH=./data/site.sqlite"
      : `OKS_DATABASE_URL=${options.databaseUrl}`,
    "",
    "# The public address of the site, once it has one (it decides whether cookies are Secure).",
    "# OKS_SITE_URL=https://example.com",
    "",
  ].join("\n");
  return [
    { path: "package.json", content: JSON.stringify(packageJson, null, 2) + "\n" },
    { path: ".env", content: env },
    {
      path: ".gitignore",
      content: "node_modules\n.next\n.env\ndata\nuploads\nnext-env.d.ts\n*.tsbuildinfo\n",
    },
    {
      path: "README.md",
      content: `# ${packageNameOf(options.dir)}\n\nA site made with ${PRODUCT}.\n\n\`\`\`bash\n${options.packageManager} ${options.packageManager === "npm" ? "run " : ""}dev\n\`\`\`\n\nThen open http://localhost:3000/admin/setup to finish the setup.\n\nThe secret key and the database settings are in \`.env\`. Do not commit that file.\n`,
    },
    {
      path: "next.config.mjs",
      content: `import { withOksPage } from ${from("next")};\n\nexport default withOksPage({});\n`,
    },
    {
      path: "tsconfig.json",
      content:
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2023",
              lib: ["dom", "dom.iterable", "ES2023"],
              strict: true,
              noEmit: true,
              esModuleInterop: true,
              module: "esnext",
              moduleResolution: "bundler",
              resolveJsonModule: true,
              isolatedModules: true,
              jsx: "react-jsx",
              incremental: true,
              skipLibCheck: true,
              plugins: [{ name: "next" }],
            },
            include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
            exclude: ["node_modules"],
          },
          null,
          2,
        ) + "\n",
    },
    // Next.js reads the matcher while it builds, so it is written here and not re-exported.
    {
      path: "proxy.ts",
      content: `export { proxy } from ${from("proxy")};\n// Next.js reads the matcher while it builds, so it is written out here and not re-exported.\nexport const config = {\n  matcher: [\n    "/((?!api|admin|_next|robots.txt|sitemap.xml|not-found-handler|test-form|favicon.ico).*)",\n  ],\n};\n`,
    },
    {
      path: "instrumentation.ts",
      content: `// Makes the tables of a new database when the server starts. Set OKS_AUTO_MIGRATE=0 to turn this off.\nexport { register } from ${from("instrumentation")};\n`,
    },
    { path: "app/layout.tsx", content: `export { default } from ${from("layout")};\n` },
    {
      path: "app/[[...slug]]/page.tsx",
      content: `export { default, generateMetadata } from ${from("site")};\n`,
    },
    {
      path: "app/not-found-handler/route.ts",
      content: `export { GET } from ${from("not-found-handler")};\n`,
    },
    {
      path: "app/admin/setup/page.tsx",
      content: `export { default, metadata } from ${from("setup-page")};\n`,
    },
    { path: "app/api/setup/route.ts", content: `export { POST } from ${from("api-setup")};\n` },
    {
      path: "app/api/auth/[...all]/route.ts",
      content: `export { GET, POST } from ${from("api-auth")};\n`,
    },
    { path: "data/.gitkeep", content: "" },
    { path: "uploads/.gitkeep", content: "" },
  ];
}

/** A new secret key: 48 random bytes as text (96 characters; the site needs at least 32). */
export const newSecret = (): string => randomBytes(48).toString("hex");

/** Writes the project into `options.dir`. The folder may be new or empty; a folder with files in it is refused. */
export function generateProject(options: InstallOptions): { dir: string; files: string[] } {
  const dir = resolve(options.dir);
  if (existsSync(dir) && readdirSync(dir).length > 0)
    throw new FolderNotEmptyError(
      `The folder ${dir} is not empty. Choose another name or an empty folder.`,
    );
  const files = projectFiles(options, newSecret());
  for (const file of files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  return { dir, files: files.map((f) => f.path) };
}
