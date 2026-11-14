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
      content: `export { proxy } from ${from("proxy")};\n// Next.js reads the matcher while it builds, so it is written out here and not re-exported.\nexport const config = {\n  matcher: [\n    "/((?!api|admin|_next|robots.txt|sitemap.xml|feed.xml|atom.xml|not-found-handler|maintenance-handler|test-form|uploads|favicon.ico).*)",\n  ],\n};\n`,
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
      path: "app/preview/[id]/page.tsx",
      content: `export { default, metadata } from ${from("preview-page")};\n`,
    },
    {
      path: "app/search/page.tsx",
      content: `export { default, metadata } from ${from("search-page")};\n`,
    },
    {
      path: "app/maintenance-handler/route.ts",
      content: `export { GET } from ${from("maintenance-handler")};\n`,
    },
    {
      path: "app/not-found-handler/route.ts",
      content: `export { GET } from ${from("not-found-handler")};\n`,
    },
    {
      path: "app/admin/setup/page.tsx",
      content: `export { default, metadata } from ${from("setup-page")};\n`,
    },
    {
      path: "app/admin/page.tsx",
      content: `export { default, metadata } from ${from("admin-page")};\n`,
    },
    {
      path: "app/admin/login/page.tsx",
      content: `export { default, metadata } from ${from("login-page")};\n`,
    },
    {
      path: "app/admin/media/page.tsx",
      content: `export { default, metadata } from ${from("media-page")};\n`,
    },
    {
      path: "app/admin/settings/general/page.tsx",
      content: `export { default, metadata } from ${from("settings-general-page")};\n`,
    },
    {
      path: "app/admin/settings/media/page.tsx",
      content: `export { default, metadata } from ${from("settings-media-page")};\n`,
    },
    {
      path: "app/admin/settings/security/page.tsx",
      content: `export { default, metadata } from ${from("settings-security-page")};\n`,
    },
    {
      path: "app/admin/settings/email/page.tsx",
      content: `export { default, metadata } from ${from("settings-email-page")};\n`,
    },
    {
      path: "app/admin/settings/maintenance/page.tsx",
      content: `export { default, metadata } from ${from("settings-maintenance-page")};\n`,
    },
    {
      path: "app/admin/settings/redirects/page.tsx",
      content: `export { default, metadata } from ${from("settings-redirects-page")};\n`,
    },
    {
      path: "app/admin/settings/search-engines/page.tsx",
      content: `export { default, metadata } from ${from("settings-seo-page")};\n`,
    },
    {
      path: "app/admin/users/page.tsx",
      content: `export { default, metadata } from ${from("users-page")};\n`,
    },
    {
      path: "app/admin/invite/[token]/page.tsx",
      content: `export { default, metadata } from ${from("invite-page")};\n`,
    },
    {
      path: "app/admin/account/page.tsx",
      content: `export { default, metadata } from ${from("account-page")};\n`,
    },
    {
      path: "app/admin/pages/page.tsx",
      content: `export { default, metadata } from ${from("pages-list-page")};\n`,
    },
    {
      path: "app/admin/posts/page.tsx",
      content: `export { default, metadata } from ${from("posts-list-page")};\n`,
    },
    {
      path: "app/admin/categories/page.tsx",
      content: `export { default, metadata } from ${from("categories-page")};\n`,
    },
    {
      path: "app/admin/menus/page.tsx",
      content: `export { default, metadata } from ${from("menus-page")};\n`,
    },
    {
      path: "app/admin/tags/page.tsx",
      content: `export { default, metadata } from ${from("tags-page")};\n`,
    },
    {
      path: "app/admin/pages/[id]/page.tsx",
      content: `export { default, metadata } from ${from("entry-edit-page")};\n`,
    },
    {
      path: "app/admin/posts/[id]/page.tsx",
      content: `export { default, metadata } from ${from("entry-edit-page")};\n`,
    },
    {
      path: "app/api/admin/entries/route.ts",
      content: `export { POST } from ${from("api-entries")};\n`,
    },
    {
      path: "app/api/admin/entries/[id]/route.ts",
      content: `export { PUT, PATCH, DELETE } from ${from("api-entry")};\n`,
    },
    {
      path: "app/api/admin/entries/[id]/revisions/route.ts",
      content: `export { GET, POST } from ${from("api-revisions")};\n`,
    },
    {
      path: "app/api/admin/entries/[id]/autosave/route.ts",
      content: `export { GET, PUT, DELETE } from ${from("api-autosave")};\n`,
    },
    {
      path: "app/api/admin/entries/[id]/editing/route.ts",
      content: `export { POST, DELETE } from ${from("api-editing")};\n`,
    },
    {
      path: "app/feed.xml/route.ts",
      content: `export { siteRss as GET } from ${from("feeds")};\n`,
    },
    {
      path: "app/atom.xml/route.ts",
      content: `export { siteAtom as GET } from ${from("feeds")};\n`,
    },
    {
      path: "app/category/[slug]/feed.xml/route.ts",
      content: `export { categoryRss as GET } from ${from("feeds")};\n`,
    },
    {
      path: "app/category/[slug]/atom.xml/route.ts",
      content: `export { categoryAtom as GET } from ${from("feeds")};\n`,
    },
    {
      path: "app/api/admin/entries/[id]/seo/route.ts",
      content: `export { GET, PUT } from ${from("api-entry-seo")};\n`,
    },
    {
      path: "app/api/admin/entries/[id]/layout/route.ts",
      content: `export { GET, PUT } from ${from("api-entry-layout")};\n`,
    },
    {
      path: "app/api/admin/entries/[id]/preview-link/route.ts",
      content: `export { POST } from ${from("api-entry-preview")};\n`,
    },
    {
      path: "app/api/admin/entries/[id]/terms/route.ts",
      content: `export { GET, PUT } from ${from("api-entry-terms")};\n`,
    },
    {
      path: "app/api/admin/media/route.ts",
      content: `export { GET, POST } from ${from("api-media")};\n`,
    },
    {
      path: "app/api/admin/media/[id]/route.ts",
      content: `export { GET, POST, PATCH, DELETE } from ${from("api-media-item")};\n`,
    },
    {
      path: "app/api/admin/settings/general/route.ts",
      content: `export { GET, PUT } from ${from("api-settings-general")};\n`,
    },
    {
      path: "app/api/admin/settings/media/route.ts",
      content: `export { GET, PUT } from ${from("api-settings-media")};\n`,
    },
    {
      path: "app/api/admin/settings/email/route.ts",
      content: `export { DELETE, GET, PUT } from ${from("api-settings-email")};\n`,
    },
    {
      path: "app/api/admin/settings/maintenance/route.ts",
      content: `export { GET, PUT } from ${from("api-settings-maintenance")};\n`,
    },
    {
      path: "app/api/admin/users/route.ts",
      content: `export { GET, POST } from ${from("api-users")};\n`,
    },
    {
      path: "app/api/admin/users/[id]/route.ts",
      content: `export { PATCH, DELETE } from ${from("api-user")};\n`,
    },
    {
      path: "app/api/admin/invitations/[id]/route.ts",
      content: `export { DELETE } from ${from("api-invitation")};\n`,
    },
    {
      path: "app/api/invite/accept/route.ts",
      content: `export { POST } from ${from("api-invite-accept")};\n`,
    },
    {
      path: "app/api/admin/redirects/route.ts",
      content: `export { GET, POST } from ${from("api-redirects")};\n`,
    },
    {
      path: "app/api/admin/redirects/[id]/route.ts",
      content: `export { DELETE } from ${from("api-redirect")};\n`,
    },
    {
      path: "app/api/admin/settings/seo/route.ts",
      content: `export { GET, PUT } from ${from("api-settings-seo")};\n`,
    },
    {
      path: "app/admin/settings/look/page.tsx",
      content: `export { default, metadata } from ${from("settings-look-page")};\n`,
    },
    {
      path: "app/api/admin/settings/theme/route.ts",
      content: `export { GET, PUT } from ${from("api-settings-theme")};\n`,
    },
    {
      path: "app/admin/settings/themes/page.tsx",
      content: `export { default, metadata } from ${from("settings-themes-page")};\n`,
    },
    {
      path: "app/admin/settings/site-editor/page.tsx",
      content: `export { default, metadata } from ${from("site-editor-page")};\n`,
    },
    {
      path: "app/admin/site-editor/preview/page.tsx",
      content: `export { default, metadata } from ${from("site-editor-preview")};\n`,
    },
    {
      path: "app/api/admin/themes/route.ts",
      content: `export { GET, POST } from ${from("api-themes")};\n`,
    },
    {
      path: "app/api/admin/themes/[id]/route.ts",
      content: `export { DELETE, POST } from ${from("api-theme")};\n`,
    },
    {
      path: "app/api/admin/themes/[id]/layouts/route.ts",
      content: `export { GET, POST } from ${from("api-theme-layouts")};\n`,
    },
    {
      path: "app/api/admin/themes/[id]/layout/route.ts",
      content: `export { DELETE, GET, POST, PUT } from ${from("api-theme-layout")};\n`,
    },
    {
      path: "app/api/admin/themes/[id]/export/route.ts",
      content: `export { GET } from ${from("api-theme-export")};\n`,
    },
    {
      path: "app/api/admin/sections/route.ts",
      content: `export { GET, POST } from ${from("api-sections")};\n`,
    },
    {
      path: "app/api/admin/sections/[id]/route.ts",
      content: `export { DELETE, GET, PATCH, POST, PUT } from ${from("api-section")};\n`,
    },
    {
      path: "app/sitemap.xml/route.ts",
      content: `export { GET } from ${from("sitemap-xml")};\n`,
    },
    {
      path: "app/robots.txt/route.ts",
      content: `export { GET } from ${from("robots-txt")};\n`,
    },
    {
      path: "app/api/admin/settings/security/route.ts",
      content: `export { GET, PUT } from ${from("api-settings-security")};\n`,
    },
    {
      path: "app/api/admin/menus/[place]/route.ts",
      content: `export { GET, PUT } from ${from("api-menu")};\n`,
    },
    {
      path: "app/api/admin/taxonomies/[key]/route.ts",
      content: `export { GET, POST } from ${from("api-taxonomy")};\n`,
    },
    {
      path: "app/api/admin/terms/[id]/route.ts",
      content: `export { PATCH, DELETE } from ${from("api-term")};\n`,
    },
    {
      path: "app/uploads/[...key]/route.ts",
      content: `export { GET } from ${from("api-uploads")};\n`,
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
