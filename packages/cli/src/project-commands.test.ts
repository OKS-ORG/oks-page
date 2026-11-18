// `oks migrate` and `oks user reset`: finding the project's settings and its `oks-page`, and what the command says when
// something is missing. The real work is tested in the oks-page package (cli-commands.test.ts).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadProjectEnv, parseEnvFile, runCli, type ProjectCommands } from "./main.js";

describe("the project's .env", () => {
  test("CLI-01: settings are read; comments, quotes, export and Windows line ends are handled", () => {
    expect(
      parseEnvFile(
        '# a comment\nOKS_SECRET=abc=def\r\nexport OKS_SQLITE_PATH="./data/site.sqlite"\nEMPTY=\nnot a setting\n  SPACED = value  \n',
      ),
    ).toEqual({
      OKS_SECRET: "abc=def",
      OKS_SQLITE_PATH: "./data/site.sqlite",
      EMPTY: "",
      SPACED: "value",
    });
  });
});

describe("oks migrate and oks user reset", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oks-cli-"));
    vi.spyOn(process, "cwd").mockReturnValue(dir);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
  const run = async (
    args: string[],
    env: Record<string, string | undefined>,
    project: ProjectCommands | null,
  ) => {
    const lines: string[] = [];
    const code = await runCli(
      args,
      (t) => lines.push(t),
      env,
      async () => {
        if (!project) throw new Error("not found");
        return project;
      },
    );
    return { code, lines };
  };
  const fake = (): ProjectCommands & { calls: unknown[][] } => {
    const calls: unknown[][] = [];
    return {
      calls,
      migrateCommand: async (out) => {
        calls.push(["migrate"]);
        out("migrated");
        return 0;
      },
      userResetCommand: async (args, out, env) => {
        calls.push(["reset", args, env["OKS_SECRET"]]);
        out("reset");
        return 0;
      },
    };
  };

  test("CLI-02: the project's .env fills in what the environment lacks, and never replaces what is there", () => {
    writeFileSync(join(dir, ".env"), "OKS_SECRET=from-env-file\nOKS_SQLITE_PATH=./a.sqlite\n");
    writeFileSync(join(dir, ".env.local"), "OKS_SECRET=from-local-file\n");
    const env: Record<string, string | undefined> = { OKS_SQLITE_PATH: "./set.sqlite" };
    loadProjectEnv(dir, env);
    expect(env).toEqual({ OKS_SECRET: "from-local-file", OKS_SQLITE_PATH: "./set.sqlite" });
  });

  test("CLI-03: oks migrate and oks user reset reach the project's commands, with the secret from .env", async () => {
    writeFileSync(join(dir, ".env"), "OKS_SECRET=the-site-secret\n");
    const project = fake();
    expect(await run(["migrate"], {}, project)).toEqual({ code: 0, lines: ["migrated"] });
    expect(await run(["user", "reset", "ann@example.com"], {}, project)).toEqual({
      code: 0,
      lines: ["reset"],
    });
    expect(project.calls).toEqual([["migrate"], ["reset", ["ann@example.com"], "the-site-secret"]]);
  });

  test("CLI-04: outside a project it says so and does nothing", async () => {
    const result = await run(["user", "reset", "ann@example.com"], {}, null);
    expect(result.code).toBe(1);
    expect(result.lines).toEqual([
      "Problem: oks-page is not installed here. Run this command in the project's folder.",
    ]);
  });

  test("CLI-05: other commands (and oks user with no reset) still show the usage", async () => {
    const result = await run(["user"], {}, fake());
    expect(result.code).toBe(2);
    expect(result.lines.join("\n")).toContain("oks user reset <email>");
  });
});
