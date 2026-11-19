// The signed update list (spec 14, UP-02, UP-03, UP-04) and the offline tool that signs it (scripts/licence.mjs).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
// @ts-expect-error The tool is a plain script with no type declarations.
import * as tool from "../../../scripts/licence.mjs";
import { readLicence } from "./licence.js";
import {
  checkUpdateList,
  mayReplaceList,
  readUpdateList,
  updateListStale,
  UPDATE_LIST_PREFIX,
} from "./update-list.js";

const run = (args: string[]) => {
  const lines: string[] = [];
  const code = tool.run(args, (text: string) => lines.push(text)) as number;
  return { code, lines };
};

const dir = mkdtempSync(join(tmpdir(), "oks-updates-"));
const make = (name: string) => {
  const where = join(dir, name);
  run(["keygen", "--out", where]);
  return {
    privateFile: join(where, "oks-licence-private.key"),
    publicFile: join(where, "oks-licence-public.key"),
    publicKey: readFileSync(join(where, "oks-licence-public.key"), "utf8").trim(),
  };
};
const current = make("current");
const next = make("next");
const stranger = make("stranger");

const sample = (over: Record<string, unknown> = {}) => ({
  v: 1,
  seq: 5,
  issued: "2026-11-19T10:00:00.000Z",
  core: { "1": "1.4.3" },
  items: [
    { key: "gallery", kind: "plugin", latest: "2.1.0", unsafe: ["2.0.0"] },
    { key: "dusk", kind: "theme", latest: "1.0.2" },
  ],
  warnings: [
    {
      id: "OKS-2026-001",
      affects: "gallery",
      versions: "<2.1.0",
      fixed: "2.1.0",
      severity: "high",
      summary: "A picture caption could run a script.",
      link: "https://example.com/advisories/OKS-2026-001",
    },
  ],
  ...over,
});
const listFile = (list: unknown) => {
  const file = join(dir, `list-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(list));
  return file;
};
const signed = (key: typeof current, list: unknown = sample(), extra: string[] = []) =>
  run(["sign-list", "--private", key.privateFile, "--list", listFile(list), ...extra]);

describe("the signed update list", () => {
  test("a list the tool signs is believed, with the current key or the next key (UP-02)", () => {
    const made = signed(current);
    expect(made.code).toBe(0);
    expect(made.lines[0]!.startsWith(`${UPDATE_LIST_PREFIX}.`)).toBe(true);
    const keys = [current.publicKey, next.publicKey];
    const read = readUpdateList(made.lines[0], keys);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.list.seq).toBe(5);
    expect(read.list.core).toEqual({ "1": "1.4.3" });
    expect(read.list.items[0]).toEqual({
      key: "gallery",
      kind: "plugin",
      latest: "2.1.0",
      unsafe: ["2.0.0"],
    });
    expect(read.list.items[1]!.unsafe).toEqual([]);
    expect(read.list.warnings[0]!.severity).toBe("high");
    // The key that was "next" signs the list on the day the key is changed, and sites that hold both still believe it.
    expect(readUpdateList(signed(next).lines[0], keys).ok).toBe(true);
  });

  test("a changed list, a list of a stranger's key, an empty key list and a licence key are all refused (UP-02)", () => {
    const token = signed(current).lines[0]!;
    const [prefix, payload, signature] = token.split(".");
    const changed = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload!, "base64url").toString()),
        warnings: [],
      }),
    ).toString("base64url");
    const keys = [current.publicKey, next.publicKey];
    expect(readUpdateList(`${prefix}.${changed}.${signature}`, keys)).toMatchObject({
      ok: false,
      reason: "This list was not signed by us, or it was changed.",
    });
    expect(readUpdateList(signed(stranger).lines[0], keys).ok).toBe(false);
    // No signing key is built in yet: no list is believed.
    expect(readUpdateList(token, []).ok).toBe(false);
    expect(readUpdateList(42, keys).ok).toBe(false);
    expect(readUpdateList("OKS1.a.b", keys)).toMatchObject({
      ok: false,
      reason: "This is not an update list.",
    });
    // A licence key signed with the same key is not an update list, and an update list is not a licence key.
    const licence = run([
      "sign",
      "--private",
      current.privateFile,
      "--covers",
      "*",
      "--sites",
      "1",
      "--kind",
      "development",
    ]).lines[0]!;
    expect(readUpdateList(licence, keys).ok).toBe(false);
    expect(readLicence(token, keys).ok).toBe(false);
  });

  test("an older list than the one held is refused; the same one is fine (UP-03)", () => {
    expect(mayReplaceList(null, { seq: 1 })).toBe(true);
    expect(mayReplaceList({ seq: 5 }, { seq: 5 })).toBe(true);
    expect(mayReplaceList({ seq: 5 }, { seq: 6 })).toBe(true);
    expect(mayReplaceList({ seq: 5 }, { seq: 4 })).toBe(false);
  });

  test("a list more than 7 days old is too old (UP-04)", () => {
    const list = { issued: "2026-11-12T10:00:00.000Z" };
    expect(updateListStale(list, new Date("2026-11-19T09:59:59.000Z"))).toBe(false);
    expect(updateListStale(list, new Date("2026-11-19T10:00:01.000Z"))).toBe(true);
  });

  test("the tool and the site refuse the same malformed lists, in plain words", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["no sequence number", { seq: 0 }],
      ["no date", { issued: "yesterday" }],
      ["a core version of another major", { core: { "1": "2.0.0" } }],
      ["a plug-in with no version", { items: [{ key: "gallery", kind: "plugin", latest: "two" }] }],
      ["an item of an unknown kind", { items: [{ key: "x", kind: "widget", latest: "1.0.0" }] }],
      [
        "a warning with a link that is not https",
        {
          warnings: [
            {
              id: "a",
              affects: "x",
              versions: "<1.0.0",
              fixed: "1.0.0",
              severity: "low",
              summary: "s",
              link: "http://example.com",
            },
          ],
        },
      ],
      [
        "a warning with an unknown severity",
        {
          warnings: [
            {
              id: "a",
              affects: "x",
              versions: "<1.0.0",
              fixed: "1.0.0",
              severity: "dire",
              summary: "s",
              link: "https://example.com",
            },
          ],
        },
      ],
    ];
    for (const [name, over] of bad) {
      const list = sample(over);
      expect(checkUpdateList(list).ok, `site: ${name}`).toBe(false);
      expect(tool.listProblem(list), `tool: ${name}`).toEqual(expect.any(String));
      const refused = signed(current, list);
      expect(refused.code, name).toBe(1);
      expect(refused.lines[0], name).toContain("Problem:");
    }
    expect(checkUpdateList(sample()).ok).toBe(true);
    expect(tool.listProblem(sample())).toBeNull();
  });

  test("sign-list takes the sequence number and the time from the command, and check-list reads the list back", () => {
    const made = signed(current, sample({ seq: 1 }), [
      "--seq",
      "9",
      "--issued",
      "2026-11-20T08:00:00Z",
    ]);
    expect(made.code).toBe(0);
    const read = readUpdateList(made.lines[0], [current.publicKey]);
    expect(read.ok && read.list.seq).toBe(9);
    expect(read.ok && read.list.issued).toBe("2026-11-20T08:00:00.000Z");
    const shown = run([
      "check-list",
      made.lines[0]!,
      "--public",
      `${current.publicFile},${next.publicFile}`,
    ]);
    expect(shown.code).toBe(0);
    expect(shown.lines).toContain("Sequence number: 9");
    expect(shown.lines).toContain("Signed with: the first key (current)");
    const viaNext = run([
      "check-list",
      signed(next).lines[0]!,
      "--public",
      `${current.publicFile},${next.publicFile}`,
    ]);
    expect(viaNext.lines).toContain("Signed with: key number 2 (next)");
    const refused = run(["check-list", made.lines[0]!, "--public", stranger.publicFile]);
    expect(refused.code).toBe(1);
    expect(refused.lines[0]).toContain("was not signed with these keys, or it was changed");
  });
});
