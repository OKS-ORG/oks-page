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
  /** Draw the words in colour (a terminal that shows it, and NO_COLOR not set). */
  color?: boolean;
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
  // The words of the design: a title, what was chosen, then a tick for each thing done, then what to do next.
  const paint = (code: string, text: string) => (io.color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const dim = (text: string) => paint("90", text);
  const bold = (text: string) => paint("1", text);
  const ok = (text: string) => paint("32", `✓ ${text}`);
  const choice = (label: string, value: string) => dim(`◇ ${label.padEnd(15)} ${value}`);
  io.out(
    [
      "",
      bold(`${PRODUCT}  ·  create a new site`),
      "",
      choice("Folder", options.dir),
      choice("Database", options.database === "postgres" ? "PostgreSQL" : "SQLite"),
      choice("Media storage", "This computer (./uploads)"),
      ...(io.interactive
        ? ["", dim("Tip: every question has a flag, for example --db sqlite --yes")]
        : []),
      "",
    ].join("\n"),
  );
  let made: { dir: string; files: string[] };
  try {
    made = generateProject(options);
  } catch (error) {
    if (!(error instanceof FolderNotEmptyError)) throw error;
    io.out(error.message);
    return 1;
  }
  io.out(ok(`Created ${made.dir} (${made.files.length} files)`));
  io.out(ok("Wrote .env with a new secret key"));
  if (options.install) {
    io.out(dim(`Installing everything with ${options.packageManager}…`));
    if (!io.run(options.packageManager, ["install"], made.dir)) {
      io.out(
        `The install did not finish. Run "${options.packageManager} install" in ${made.dir} when you can.`,
      );
      return 1;
    }
    io.out(ok(`Installed everything with ${options.packageManager}`));
  }
  const run = options.packageManager === "npm" ? "npm run dev" : `${options.packageManager} dev`;
  io.out(
    `\n${bold("Next:")}\n   cd ${options.dir}\n${options.install ? "" : `   ${options.packageManager} install\n`}   ${run}\n\nThen open http://localhost:3000/admin/setup to finish the setup.`,
  );
  return 0;
}
