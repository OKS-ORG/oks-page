// `create-oks-page [folder] [options]`: asks a few questions, writes the project, installs its dependencies.
import { FolderNotEmptyError, generateProject, PRODUCT } from "./generate.js";
import {
  complete,
  DATABASES,
  parseArgs,
  UsageError,
  type GivenOptions,
  type InstallOptions,
} from "./options.js";

const USAGE = `Usage: create-${PRODUCT} <folder> [options]

  --db sqlite|postgres      The database. Default: sqlite (no server needed).
  --database-url <url>      For PostgreSQL: postgres://user:password@host/db
  --storage local           Where uploads go. Default: local (./uploads).
  --package-manager <name>  npm, pnpm or yarn. Default: the one that started this command.
  --no-install              Write the files and stop: install the dependencies yourself.
  --yes, -y                 Do not ask questions; use the defaults.
`;

export interface Io {
  out(text: string): void;
  /** Asks one question; resolves to the answer, or "" when the person only pressed Enter. */
  ask(question: string): Promise<string>;
  interactive: boolean;
  /** Runs the install command; returns true when it succeeded. */
  run(command: string, args: string[], cwd: string): boolean;
}

/** Asks what the flags did not say. Only when there is a person to ask and `--yes` was not given. */
async function questions(given: GivenOptions, io: Io): Promise<GivenOptions> {
  if (given.yes || !io.interactive) return given;
  const next = { ...given };
  if (!next.dir) next.dir = (await io.ask("Folder for the new site (my-site): ")) || "my-site";
  if (!next.database) {
    const answer = (await io.ask(`Database: ${DATABASES.join(" or ")} (sqlite): `)) || "sqlite";
    if (!(DATABASES as readonly string[]).includes(answer))
      throw new UsageError(`The database must be one of: ${DATABASES.join(", ")}.`);
    next.database = answer as (typeof DATABASES)[number];
  }
  if (next.database === "postgres" && !next.databaseUrl)
    next.databaseUrl = await io.ask("PostgreSQL connection URL: ");
  return next;
}

/** Runs the installer. Returns the exit code: 0 done, 1 something went wrong, 2 the command was not understood. */
export async function main(argv: string[], io: Io, userAgent?: string): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.out(USAGE);
    return 0;
  }
  let options: InstallOptions;
  try {
    options = complete(await questions(parseArgs(argv), io), userAgent);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.out(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  let made: { dir: string; files: string[] };
  try {
    made = generateProject(options);
  } catch (error) {
    if (!(error instanceof FolderNotEmptyError)) throw error;
    io.out(error.message);
    return 1;
  }
  io.out(`Created ${made.dir} (${made.files.length} files, with a new secret key in .env).`);
  if (options.install) {
    io.out(`Installing dependencies with ${options.packageManager}…`);
    if (!io.run(options.packageManager, ["install"], made.dir)) {
      io.out(
        `The install did not finish. Run "${options.packageManager} install" in ${made.dir} when you can.`,
      );
      return 1;
    }
  }
  const run = options.packageManager === "npm" ? "npm run dev" : `${options.packageManager} dev`;
  io.out(
    `\nNext:\n  cd ${options.dir}\n${options.install ? "" : `  ${options.packageManager} install\n`}  ${run}\nThen open http://localhost:3000/admin/setup to finish the setup.`,
  );
  return 0;
}
