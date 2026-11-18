#!/usr/bin/env node
import { runCli } from "./main.js";

const code = await runCli(process.argv.slice(2), (text) => console.log(text));
process.exitCode = code;
// The database connection of a command such as `oks user reset` can keep the process alive: leave once the text is written.
process.stdout.write("", () => process.exit(code));
