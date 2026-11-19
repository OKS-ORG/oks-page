// The offline signing tool (scripts/licence.mjs, ADR 0037): a key it makes is accepted by the site's own check, and the
// private key is kept safe.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
// @ts-expect-error The tool is a plain script with no type declarations.
import * as tool from "../../../scripts/licence.mjs";
import { licenceState, readLicence } from "./licence.js";

const run = (args: string[]) => {
  const lines: string[] = [];
  const code = tool.run(args, (text: string) => lines.push(text)) as number;
  return { code, lines };
};
const folder = () => mkdtempSync(join(tmpdir(), "oks-licence-"));

describe("the licence signing tool", () => {
  test("keygen: makes the pair, keeps the private key private and never overwrites", () => {
    const dir = join(folder(), "keys");
    const made = run(["keygen", "--out", dir]);
    expect(made.code).toBe(0);
    const privateKey = readFileSync(join(dir, "oks-licence-private.key"), "utf8").trim();
    const publicKey = readFileSync(join(dir, "oks-licence-public.key"), "utf8").trim();
    // The private key is never printed; the public key and its fingerprint are.
    expect(made.lines.join("\n")).not.toContain(privateKey);
    expect(made.lines.join("\n")).toContain(publicKey);
    expect(made.lines.join("\n")).toContain(`Fingerprint: ${tool.fingerprint(publicKey)}`);
    if (process.platform !== "win32")
      expect(statSync(join(dir, "oks-licence-private.key")).mode & 0o077).toBe(0);
    const again = run(["keygen", "--out", dir]);
    expect(again.code).toBe(1);
    expect(again.lines[0]).toContain("never overwritten");
    expect(readFileSync(join(dir, "oks-licence-private.key"), "utf8").trim()).toBe(privateKey);
  });

  test("keygen refuses a folder inside a git repository", () => {
    const repo = folder();
    mkdirSync(join(repo, ".git"));
    const result = run(["keygen", "--out", join(repo, "keys")]);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain("inside a git repository");
    expect(existsSync(join(repo, "keys"))).toBe(false);
  });

  test("a key it signs is accepted by the site's own check, with the right meaning", () => {
    const dir = join(folder(), "keys");
    run(["keygen", "--out", dir]);
    const publicKey = readFileSync(join(dir, "oks-licence-public.key"), "utf8").trim();
    const priv = join(dir, "oks-licence-private.key");
    const yearly = run([
      "sign",
      "--private",
      priv,
      "--covers",
      "gallery,forms",
      "--sites",
      "3",
      "--kind",
      "normal",
      "--until",
      "2027-11-19",
      "--holder",
      "Ben's Bakery",
      "--issued",
      "2026-11-19",
    ]);
    expect(yearly.code).toBe(0);
    const read = readLicence(yearly.lines[0], [publicKey]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.licence).toMatchObject({
      v: 1,
      kind: "normal",
      covers: ["gallery", "forms"],
      sites: 3,
      updatesUntil: "2027-11-19",
      maxMajor: null,
      issued: "2026-11-19",
      holder: "Ben's Bakery",
    });
    const state = licenceState(read.licence, {
      item: "gallery",
      host: "bakery.example",
      now: new Date("2026-12-01"),
    });
    expect(state.updates).toBe(true);
    // The tool's own check says the same things in words.
    const explained = run([
      "check",
      yearly.lines[0]!,
      "--public",
      join(dir, "oks-licence-public.key"),
    ]);
    expect(explained.code).toBe(0);
    expect(explained.lines).toContain("Updates until: 2027-11-19");
    expect(explained.lines).toContain("Holder: Ben's Bakery");

    const lifetime = run([
      "sign",
      "--private",
      priv,
      "--covers",
      "*",
      "--sites",
      "1",
      "--kind",
      "normal",
      "--max-major",
      "2",
    ]);
    const life = readLicence(lifetime.lines[0], [publicKey]);
    expect(life.ok && life.licence.maxMajor).toBe(2);
    expect(life.ok && life.licence.updatesUntil).toBe(null);
    const trial = run([
      "sign",
      "--private",
      priv,
      "--covers",
      "gallery",
      "--sites",
      "1",
      "--kind",
      "trial",
      "--until",
      "2026-12-19",
    ]);
    expect(readLicence(trial.lines[0], [publicKey]).ok).toBe(true);
    const dev = run([
      "sign",
      "--private",
      priv,
      "--covers",
      "*",
      "--sites",
      "1",
      "--kind",
      "development",
    ]);
    expect(readLicence(dev.lines[0], [publicKey]).ok).toBe(true);
  });

  test("a changed key, or a key from another signing key, is refused", () => {
    const a = join(folder(), "a");
    const b = join(folder(), "b");
    run(["keygen", "--out", a]);
    run(["keygen", "--out", b]);
    const key = run([
      "sign",
      "--private",
      join(a, "oks-licence-private.key"),
      "--covers",
      "gallery",
      "--sites",
      "1",
      "--kind",
      "normal",
      "--until",
      "2027-01-01",
    ]).lines[0]!;
    const publicA = readFileSync(join(a, "oks-licence-public.key"), "utf8").trim();
    const publicB = readFileSync(join(b, "oks-licence-public.key"), "utf8").trim();
    expect(readLicence(key, [publicA]).ok).toBe(true);
    expect(readLicence(key, [publicB]).ok).toBe(false);
    const [prefix, payload, signature] = key.split(".");
    const changed = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), sites: 99 }),
    ).toString("base64url");
    expect(readLicence(`${prefix}.${changed}.${signature}`, [publicA]).ok).toBe(false);
    const refused = run([
      "check",
      `${prefix}.${changed}.${signature}`,
      "--public",
      join(a, "oks-licence-public.key"),
    ]);
    expect(refused.code).toBe(1);
    expect(refused.lines[0]).toContain("was not made with this signing key, or it was changed");
  });

  test("it refuses what the site would refuse, in plain words", () => {
    const dir = join(folder(), "keys");
    run(["keygen", "--out", dir]);
    const priv = join(dir, "oks-licence-private.key");
    const base = ["sign", "--private", priv, "--covers", "gallery", "--sites", "1"];
    const problems = (args: string[]) => {
      const r = run([...base, ...args]);
      expect(r.code).toBe(1);
      return r.lines.join("\n");
    };
    expect(problems(["--kind", "normal"])).toContain(
      "needs an end date (yearly) or a major version (lifetime)",
    );
    expect(problems(["--kind", "normal", "--until", "2027-01-01", "--max-major", "2"])).toContain(
      "Choose one",
    );
    expect(problems(["--kind", "trial"])).toContain("A trial needs an end date");
    expect(problems(["--kind", "gift", "--until", "2027-01-01"])).toContain("Choose the kind");
    expect(problems(["--kind", "normal", "--until", "next year"])).toContain("2027-11-19");
    expect(
      run([
        "sign",
        "--private",
        priv,
        "--covers",
        "gallery",
        "--sites",
        "0",
        "--kind",
        "development",
      ]).lines.join(),
    ).toContain("number of sites");
    expect(
      run([
        "sign",
        "--private",
        priv,
        "--covers",
        "",
        "--sites",
        "1",
        "--kind",
        "development",
      ]).lines.join(),
    ).toContain("Say what the key covers");
    expect(run(["nonsense"]).code).toBe(2);
  });
});
