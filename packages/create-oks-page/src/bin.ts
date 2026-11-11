#!/usr/bin/env node
// The command: the real terminal around `main`.
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { main, type Io } from "./cli.js";

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

const io: Io = {
  interactive,
  out: (text) => console.log(text),
  ask: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  },
  run: (command, args, cwd) =>
    spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" })
      .status === 0,
};

main(process.argv.slice(2), io, process.env["npm_config_user_agent"]).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
