// The questions of the installer (installation guide, "What the installer asks") and their command-line flags.
export const DATABASES = ["sqlite", "postgres"] as const;
export type Database = (typeof DATABASES)[number];
export const STORAGES = ["local"] as const;
export type Storage = (typeof STORAGES)[number];
export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export interface InstallOptions {
  /** The folder to create. */
  dir: string;
  database: Database;
  /** For PostgreSQL: the connection URL. */
  databaseUrl?: string;
  storage: Storage;
  packageManager: PackageManager;
  /** Install the dependencies after the files are written. */
  install: boolean;
  /** Developers only: link the package from this workspace instead of the registry (`--workspace`). */
  workspace: boolean;
}

/** What was asked on the command line. Anything missing is asked in a question, or takes its default with `--yes`. */
export interface GivenOptions extends Partial<Omit<InstallOptions, "install">> {
  install?: boolean;
  yes: boolean;
}

export class UsageError extends Error {}

const flagValue = (args: string[], i: number, name: string): string => {
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value.`);
  return value;
};

const oneOf = <T extends string>(name: string, value: string, allowed: readonly T[]): T => {
  if (!(allowed as readonly string[]).includes(value))
    throw new UsageError(`${name} must be one of: ${allowed.join(", ")}.`);
  return value as T;
};

export function parseArgs(args: string[]): GivenOptions {
  const given: GivenOptions = { yes: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--yes" || arg === "-y") given.yes = true;
    else if (arg === "--no-install") given.install = false;
    else if (arg === "--workspace") given.workspace = true;
    else if (arg === "--db") given.database = oneOf("--db", flagValue(args, i++, arg), DATABASES);
    else if (arg === "--database-url") given.databaseUrl = flagValue(args, i++, arg);
    else if (arg === "--storage")
      given.storage = oneOf("--storage", flagValue(args, i++, arg), STORAGES);
    else if (arg === "--package-manager")
      given.packageManager = oneOf(
        "--package-manager",
        flagValue(args, i++, arg),
        PACKAGE_MANAGERS,
      );
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option ${arg}.`);
    else if (given.dir === undefined) given.dir = arg;
    else throw new UsageError(`Only one folder name is expected, but there is also "${arg}".`);
  }
  return given;
}

/** The package manager that started the installer, from `npm_config_user_agent` ("pnpm/10.28.0 npm/? node/v22 ..."). */
export function detectPackageManager(userAgent: string | undefined): PackageManager {
  const name = userAgent?.split(" ")[0]?.split("/")[0];
  return (PACKAGE_MANAGERS as readonly (string | undefined)[]).includes(name)
    ? (name as PackageManager)
    : "npm";
}

/** The final options, from the flags and the defaults. A missing folder name or PostgreSQL URL is an error here. */
export function complete(given: GivenOptions, userAgent?: string): InstallOptions {
  if (!given.dir) throw new UsageError("Give the folder to create, for example: my-site");
  const database = given.database ?? "sqlite";
  if (database === "postgres") {
    if (!given.databaseUrl) throw new UsageError("PostgreSQL needs --database-url postgres://…");
    if (!/^postgres(ql)?:\/\//.test(given.databaseUrl))
      throw new UsageError("--database-url must start with postgres:// or postgresql://");
  }
  return {
    dir: given.dir,
    database,
    ...(given.databaseUrl ? { databaseUrl: given.databaseUrl } : {}),
    storage: given.storage ?? "local",
    packageManager: given.packageManager ?? detectPackageManager(userAgent),
    install: given.install ?? true,
    workspace: given.workspace ?? false,
  };
}
