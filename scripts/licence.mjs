// The offline tool that makes licence keys (ADR 0037). Run it on your own computer, with nothing but Node: it needs no
// packages and never uses the network. The private key never leaves the folder you choose and is never printed.
//
//   node scripts/licence.mjs keygen --out <folder>
//        Makes the signing key pair in <folder>. Put the printed public key into LICENCE_PUBLIC_KEYS (packages/core).
//   node scripts/licence.mjs sign --private <file> --covers <item,item | *> --sites <n> --kind <normal|trial|development>
//        (--until <YYYY-MM-DD> | --max-major <n>) [--holder <text>] [--id <text>] [--issued <YYYY-MM-DD>]
//        Prints one licence key. A normal key is either yearly (--until) or lifetime for a major version (--max-major).
//   node scripts/licence.mjs check <key> --public <file>
//        Reads a key back in plain words, as a site would, so you can test it before you send it.
import { Buffer } from "node:buffer";
import {
  createPrivateKey,
  createPublicKey,
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PREFIX = "OKS1";
export const PRIVATE_FILE = "oks-licence-private.key";
export const PUBLIC_FILE = "oks-licence-public.key";

const KINDS = ["normal", "trial", "development"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value) =>
  typeof value === "string" && DAY.test(value) && !Number.isNaN(Date.parse(value));
const today = () => new Date().toISOString().slice(0, 10);

/** True when this folder, or one above it, is a git repository: a private key must never be written there. */
export function insideRepository(folder) {
  let current = path.resolve(folder);
  for (;;) {
    if (existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** A short fingerprint of a public key, to compare the copy in the product with the one made here. */
export const fingerprint = (publicKeyBase64) =>
  createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("hex").slice(0, 16);

/** A new key pair: the private key (PKCS#8) and the public key (SPKI), each as base64. */
export function makeKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

/**
 * Checks what a key will say and returns the payload, or a list of problems in plain words. Nothing is signed that
 * the site's own check would refuse.
 */
export function buildPayload(input) {
  const problems = [];
  const kind = input.kind;
  if (!KINDS.includes(kind)) problems.push("Choose the kind: normal, trial or development.");
  const covers = Array.isArray(input.covers)
    ? input.covers.map((c) => String(c).trim()).filter(Boolean)
    : [];
  if (covers.length === 0)
    problems.push("Say what the key covers: one or more plug-in or theme keys, or * for all.");
  if (covers.length > 100) problems.push("A key can cover at most 100 items.");
  if (covers.includes("*") && covers.length > 1)
    problems.push("* covers everything; do not list other items with it.");
  const sites = Number(input.sites);
  if (!Number.isInteger(sites) || sites < 1)
    problems.push("Give the number of sites, a whole number from 1.");
  const until = input.until ?? null;
  const maxMajor =
    input.maxMajor === undefined || input.maxMajor === null ? null : Number(input.maxMajor);
  if (until !== null && !isDay(until)) problems.push("The end date must look like 2027-11-19.");
  if (maxMajor !== null && !(Number.isInteger(maxMajor) && maxMajor >= 1))
    problems.push("The major version must be a whole number from 1.");
  if (until !== null && maxMajor !== null)
    problems.push(
      "Choose one: a yearly key has an end date, a lifetime key has a major version, not both.",
    );
  if (kind === "trial" && until === null) problems.push("A trial needs an end date (--until).");
  if (kind === "trial" && maxMajor !== null)
    problems.push("A trial has an end date, not a major version.");
  if (kind === "normal" && until === null && maxMajor === null)
    problems.push("A normal key needs an end date (yearly) or a major version (lifetime).");
  const issued = input.issued ?? today();
  if (!isDay(issued)) problems.push("The issue date must look like 2026-11-19.");
  const id = input.id ?? `lic_${randomBytes(9).toString("base64url")}`;
  if (typeof id !== "string" || id === "" || id.length > 80)
    problems.push("The key's id must be 1 to 80 characters.");
  const holder = input.holder === undefined ? undefined : String(input.holder).trim().slice(0, 80);
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    payload: {
      v: 1,
      id,
      kind,
      covers,
      sites,
      updatesUntil: until,
      maxMajor,
      issued,
      ...(holder ? { holder } : {}),
    },
  };
}

/** Signs a payload: `OKS1.<payload>.<signature>`. */
export function signPayload(payload, privateKeyBase64) {
  const body = `${PREFIX}.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  const key = createPrivateKey({
    key: Buffer.from(privateKeyBase64.trim(), "base64"),
    format: "der",
    type: "pkcs8",
  });
  return `${body}.${edSign(null, Buffer.from(body, "utf8"), key).toString("base64url")}`;
}

/** What a key says, in plain words, or why it is refused. */
export function explainKey(token, publicKeyBase64) {
  const parts = String(token).trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX)
    return { ok: false, reason: "This is not a licence key." };
  let signed;
  try {
    signed = edVerify(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
      createPublicKey({
        key: Buffer.from(publicKeyBase64.trim(), "base64"),
        format: "der",
        type: "spki",
      }),
      Buffer.from(parts[2], "base64url"),
    );
  } catch {
    signed = false;
  }
  if (!signed)
    return { ok: false, reason: "This key was not made with this signing key, or it was changed." };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "The key could not be read." };
  }
  const lines = [
    `Kind: ${payload.kind}`,
    `Covers: ${Array.isArray(payload.covers) ? payload.covers.join(", ") : "?"}`,
    `Sites: ${payload.sites}`,
    payload.updatesUntil
      ? `Updates until: ${payload.updatesUntil}`
      : payload.maxMajor
        ? `Lifetime for version ${payload.maxMajor} and the ones before it`
        : "No end date",
    `Issued: ${payload.issued}`,
    `Id: ${payload.id}`,
    ...(payload.holder ? [`Holder: ${payload.holder}`] : []),
  ];
  return { ok: true, payload, lines };
}

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const USAGE = [
  "Usage: node scripts/licence.mjs keygen --out <folder>",
  "       node scripts/licence.mjs sign --private <file> --covers <item,item | *> --sites <n> --kind <normal|trial|development>",
  "                                     (--until <YYYY-MM-DD> | --max-major <n>) [--holder <text>] [--id <text>] [--issued <YYYY-MM-DD>]",
  "       node scripts/licence.mjs check <key> --public <file>",
].join("\n");

/** Runs one command and returns the exit code: 0 done, 1 refused, 2 not understood. */
export function run(argv, out) {
  const [command, ...rest] = argv;
  try {
    if (command === "keygen") {
      const folder = flag(rest, "--out");
      if (!folder) {
        out(USAGE);
        return 2;
      }
      if (insideRepository(folder)) {
        out(
          "Refused: that folder is inside a git repository, so the private key could be committed by mistake. Choose a folder outside every repository, such as a folder on an encrypted drive.",
        );
        return 1;
      }
      const privateFile = path.join(folder, PRIVATE_FILE);
      const publicFile = path.join(folder, PUBLIC_FILE);
      if (existsSync(privateFile) || existsSync(publicFile)) {
        out(
          `Refused: ${folder} already has a signing key. It is never overwritten; choose another folder.`,
        );
        return 1;
      }
      mkdirSync(folder, { recursive: true });
      const { privateKey, publicKey } = makeKeyPair();
      writeFileSync(privateFile, privateKey + "\n", { mode: 0o600, flag: "wx" });
      writeFileSync(publicFile, publicKey + "\n", { flag: "wx" });
      out(`Signing key made in ${folder}.`);
      out(
        `Keep ${PRIVATE_FILE} offline and make a backup: a lost key cannot be recovered and a leaked key cannot be taken back.`,
      );
      out("It was not printed. The public key is safe to share; put it into LICENCE_PUBLIC_KEYS:");
      out(publicKey);
      out(`Fingerprint: ${fingerprint(publicKey)}`);
      return 0;
    }
    if (command === "sign") {
      const privateFile = flag(rest, "--private");
      if (!privateFile) {
        out(USAGE);
        return 2;
      }
      const built = buildPayload({
        kind: flag(rest, "--kind"),
        covers: (flag(rest, "--covers") ?? "").split(","),
        sites: flag(rest, "--sites"),
        until: flag(rest, "--until") ?? null,
        maxMajor: flag(rest, "--max-major") ?? null,
        ...(flag(rest, "--holder") !== undefined ? { holder: flag(rest, "--holder") } : {}),
        ...(flag(rest, "--id") !== undefined ? { id: flag(rest, "--id") } : {}),
        ...(flag(rest, "--issued") !== undefined ? { issued: flag(rest, "--issued") } : {}),
      });
      if (!built.ok) {
        for (const p of built.problems) out(`Problem: ${p}`);
        return 1;
      }
      out(signPayload(built.payload, readFileSync(privateFile, "utf8")));
      return 0;
    }
    if (command === "check") {
      const publicFile = flag(rest, "--public");
      const token = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--public");
      if (!publicFile || !token) {
        out(USAGE);
        return 2;
      }
      const result = explainKey(token, readFileSync(publicFile, "utf8"));
      if (!result.ok) {
        out(`Refused: ${result.reason}`);
        return 1;
      }
      for (const line of result.lines) out(line);
      return 0;
    }
  } catch (error) {
    out(`Problem: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  out(USAGE);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = run(process.argv.slice(2), (text) => console.log(text));
