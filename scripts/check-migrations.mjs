// The generated migrations must match the schema files: regenerate them and fail if anything changes.
import { execFileSync } from "node:child_process";

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
run("pnpm", ["--filter", "@oks-page/db", "generate"]);
const changed = run("git", ["status", "--porcelain", "--", "packages/db/drizzle"]).trim();
if (changed) {
  console.log(
    "FAIL the migrations do not match the schema files. Run `pnpm --filter @oks-page/db generate` and commit:\n" +
      changed,
  );
  process.exit(1);
}
console.log("ok   migrations match the schema files");
