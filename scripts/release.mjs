// Prepares and publishes the packages that make up the product.
//
//   node scripts/release.mjs                 check every package and pack it (nothing is sent anywhere)
//   node scripts/release.mjs --version 0.1.0-beta.1   set one version in every package and in the packages' links to each other
//   node scripts/release.mjs --publish       build, check, and publish in dependency order to npm
//
// Publishing needs `npm login` first (done by a person). The tag defaults to "beta" so that nobody
// gets a first release by accident; pass --tag latest for a stable one.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

/** What each package puts in its published folder, besides package.json, README and LICENSE. */
const FILES = {
  "@oks-page/admin": ["dist", "src/shell.css"],
  "@oks-page/db": ["dist", "drizzle"],
  [JSON.parse(readFileSync(join(root, "brand.json"), "utf8")).product]: ["dist", "cache-handlers"],
};

export function packages() {
  const found = [];
  for (const name of readdirSync(join(root, "packages")).sort()) {
    const file = join(root, "packages", name, "package.json");
    if (!existsSync(file)) continue;
    found.push({
      dir: join(root, "packages", name),
      file,
      json: JSON.parse(readFileSync(file, "utf8")),
    });
  }
  return found;
}

function save(pkg) {
  writeFileSync(pkg.file, JSON.stringify(pkg.json, null, 2) + "\n");
}

/** Packages in the order they must be published: a package comes after everything it depends on. */
export function inOrder(list) {
  const names = new Set(list.map((p) => p.json.name));
  const done = new Set();
  const out = [];
  const visit = (pkg, trail = []) => {
    if (done.has(pkg.json.name)) return;
    if (trail.includes(pkg.json.name))
      throw new Error(
        `packages depend on each other in a circle: ${[...trail, pkg.json.name].join(" > ")}`,
      );
    const deps = { ...pkg.json.dependencies, ...pkg.json.optionalDependencies };
    for (const dep of Object.keys(deps)) {
      if (names.has(dep))
        visit(
          list.find((p) => p.json.name === dep),
          [...trail, pkg.json.name],
        );
    }
    done.add(pkg.json.name);
    out.push(pkg);
  };
  for (const pkg of list) visit(pkg);
  return out;
}

const REPOSITORY = { type: "git", url: "git+https://github.com/OKS-ORG/oks-page.git" };

/** Fills in what npm needs to show a package and to publish it publicly. Safe to run again. */
function prepare(pkg, version) {
  const j = pkg.json;
  delete j.private;
  if (version) j.version = version;
  j.license = "MIT";
  j.repository = { ...REPOSITORY, directory: `packages/${pkg.dir.split(/[\\/]/).pop()}` };
  j.homepage = "https://github.com/OKS-ORG/oks-page#readme";
  j.bugs = { url: "https://github.com/OKS-ORG/oks-page/issues" };
  j.files = FILES[j.name] ?? ["dist"];
  j.engines = { node: ">=22" };
  j.publishConfig = { access: "public" };
  if (!j.type) j.type = "module";
  save(pkg);
}

function run(cmd, cmdArgs, options = {}) {
  return execFileSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", ...options });
}

export function main() {
  const list = packages();
  const version = option("--version");
  for (const pkg of list) prepare(pkg, version);

  const ordered = inOrder(list);
  const problems = [];
  for (const pkg of ordered) {
    const j = pkg.json;
    if (!j.version || j.version === "0.0.0")
      problems.push(`${j.name}: version is ${j.version}; run with --version`);
    for (const [dep, range] of Object.entries({ ...j.dependencies })) {
      if (range.startsWith("link:") || range.startsWith("file:"))
        problems.push(`${j.name}: ${dep} is "${range}"`);
    }
  }
  const versions = new Set(ordered.map((p) => p.json.version));
  if (versions.size > 1)
    problems.push(`packages have different versions: ${[...versions].join(", ")}`);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }

  console.log(`Order: ${ordered.map((p) => p.json.name).join(" -> ")}`);
  if (flag("--publish") || flag("--pack")) {
    run("pnpm", ["build"]);
    const out = resolve(option("--out") ?? join(root, ".oks", "packs"));
    mkdirSync(out, { recursive: true });
    for (const pkg of ordered) {
      if (flag("--publish")) {
        run(
          "pnpm",
          ["publish", "--access", "public", "--tag", option("--tag") ?? "beta", "--no-git-checks"],
          { cwd: pkg.dir },
        );
      } else {
        run("pnpm", ["pack", "--pack-destination", out], { cwd: pkg.dir });
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
