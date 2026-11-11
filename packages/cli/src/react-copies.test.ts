import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { checkPlugin } from "./check.js";
import { describeReactCopies, findReactCopies } from "./react-copies.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "oks-react-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function react(at: string, version = "19.3.1"): void {
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "package.json"), JSON.stringify({ name: "react", version }));
}

describe("one copy of React (AD-47)", () => {
  test("one copy is fine, and says nothing", () => {
    const dir = tmp();
    react(join(dir, "node_modules", "react"));
    const copies = findReactCopies(dir);
    expect(copies).toHaveLength(1);
    expect(describeReactCopies(copies)).toBeNull();
  });

  test("a second copy inside another package is found and described", () => {
    const dir = tmp();
    react(join(dir, "node_modules", "react"));
    react(join(dir, "node_modules", "oks-ui", "node_modules", "react"), "19.0.0");
    const copies = findReactCopies(dir);
    expect(copies).toHaveLength(2);
    expect(describeReactCopies(copies)).toContain("2 copies of React");
  });

  test("two links to the same copy count once (how pnpm shares a package)", () => {
    const dir = tmp();
    react(join(dir, "store", "react"));
    mkdirSync(join(dir, "node_modules", "oks-ui", "node_modules"), { recursive: true });
    symlinkSync(join(dir, "store", "react"), join(dir, "node_modules", "react"));
    symlinkSync(
      join(dir, "store", "react"),
      join(dir, "node_modules", "oks-ui", "node_modules", "react"),
    );
    expect(findReactCopies(dir)).toHaveLength(1);
  });

  test("a package that is not React, with the name react in a folder, is ignored", () => {
    const dir = tmp();
    mkdirSync(join(dir, "node_modules", "react"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "react", "package.json"),
      JSON.stringify({ name: "not-react" }),
    );
    expect(findReactCopies(dir)).toEqual([]);
  });

  test("oks check: a build-time plugin that brings its own React fails", async () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "p",
        version: "1.0.0",
        oksPage: {
          type: "plugin",
          id: "my-plugin",
          runtime: "build",
          permissions: [],
          hooks: [],
          blocks: [],
        },
      }),
    );
    react(join(dir, "node_modules", "react"));
    const result = await checkPlugin(dir);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("react-copy");
  });

  test("the real admin reaches exactly one copy of React", () => {
    const admin = join(import.meta.dirname, "..", "..", "admin");
    expect(findReactCopies(admin)).toHaveLength(1);
  });
});
