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
//   node scripts/licence.mjs sign-list --private <file> --list <list.json> [--seq <n>] [--issued <date and time>]
//        Signs the update list (ADR 0039, spec 14): prints one `OKU1.…` line to publish. The list file has the core
//        versions, the plug-ins and themes and the security warnings; the sequence number must rise with every list.
//   node scripts/licence.mjs check-list <list> --public <file>[,<file>]
//        Reads a signed list back, with the current and the next public key, before you publish it.
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
export const LIST_PREFIX = "OKU1";
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

const isVersion = (v) => typeof v === "string" && /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(v);
const isText = (v, max = 500) => typeof v === "string" && v !== "" && v.length <= max;
const isHttps = (v) => {
  try {
    return typeof v === "string" && v.length <= 500 && new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

/** What is wrong with an update list, in plain words, or null when a site would accept its shape (as core does). */
export function listProblem(o) {
  if (!o || typeof o !== "object" || Array.isArray(o) || o.v !== 1)
    return "The list must have v: 1.";
  if (!Number.isInteger(o.seq) || o.seq < 1)
    return "The list needs a sequence number (seq) from 1.";
  if (typeof o.issued !== "string" || Number.isNaN(Date.parse(o.issued)))
    return "The list needs a date (issued).";
  if (!o.core || typeof o.core !== "object" || Array.isArray(o.core))
    return "The list needs core versions.";
  for (const [major, version] of Object.entries(o.core))
    if (!/^\d+$/.test(major) || !isVersion(version) || !version.startsWith(`${major}.`))
      return `The core version for ${major} is not valid.`;
  if (!Array.isArray(o.items) || o.items.length > 5000)
    return "The list of plug-ins and themes is not valid.";
  for (const i of o.items) {
    const unsafe = i?.unsafe ?? [];
    if (
      !isText(i?.key, 100) ||
      (i.kind !== "plugin" && i.kind !== "theme") ||
      !isVersion(i.latest) ||
      !Array.isArray(unsafe) ||
      !unsafe.every(isVersion)
    )
      return `The entry ${JSON.stringify(i?.key ?? i)} is not valid.`;
  }
  const warnings = o.warnings ?? [];
  if (!Array.isArray(warnings) || warnings.length > 1000)
    return "The security warnings are not valid.";
  for (const w of warnings)
    if (
      !isText(w?.id, 100) ||
      !isText(w.affects, 100) ||
      !isText(w.versions, 100) ||
      !isVersion(w.fixed) ||
      !["low", "medium", "high", "critical"].includes(w.severity) ||
      !isText(w.summary) ||
      !isHttps(w.link)
    )
      return `The security warning ${JSON.stringify(w?.id ?? w)} is not valid.`;
  return null;
}

/** Signs an update list: `OKU1.<payload>.<signature>`. */
export function signList(list, privateKeyBase64) {
  const body = `${LIST_PREFIX}.${Buffer.from(JSON.stringify(list), "utf8").toString("base64url")}`;
  const key = createPrivateKey({
    key: Buffer.from(privateKeyBase64.trim(), "base64"),
    format: "der",
    type: "pkcs8",
  });
  return `${body}.${edSign(null, Buffer.from(body, "utf8"), key).toString("base64url")}`;
}

/** Reads a signed list with one or more public keys (the current and the next one). */
export function explainList(token, publicKeys) {
  const parts = String(token).trim().split(".");
  if (parts.length !== 3 || parts[0] !== LIST_PREFIX)
    return { ok: false, reason: "This is not an update list." };
  const signedBy = publicKeys.findIndex((publicKey) => {
    try {
      return edVerify(
        null,
        Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
        createPublicKey({
          key: Buffer.from(publicKey.trim(), "base64"),
          format: "der",
          type: "spki",
        }),
        Buffer.from(parts[2], "base64url"),
      );
    } catch {
      return false;
    }
  });
  if (signedBy < 0)
    return { ok: false, reason: "This list was not signed with these keys, or it was changed." };
  let list;
  try {
    list = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "The list could not be read." };
  }
  const problem = listProblem(list);
  if (problem) return { ok: false, reason: problem };
  return { ok: true, list, signedBy };
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
  "       node scripts/licence.mjs sign-list --private <file> --list <list.json> [--seq <n>] [--issued <date and time>]",
  "       node scripts/licence.mjs check-list <list> --public <file>[,<file>]",
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
    if (command === "sign-list") {
      const privateFile = flag(rest, "--private");
      const listFile = flag(rest, "--list");
      if (!privateFile || !listFile) {
        out(USAGE);
        return 2;
      }
      const list = JSON.parse(readFileSync(listFile, "utf8"));
      if (flag(rest, "--seq") !== undefined) list.seq = Number(flag(rest, "--seq"));
      list.issued = flag(rest, "--issued") ?? list.issued ?? new Date().toISOString();
      list.v = 1;
      const problem = listProblem(list);
      if (problem) {
        out(`Problem: ${problem}`);
        return 1;
      }
      out(
        signList(
          { ...list, issued: new Date(list.issued).toISOString() },
          readFileSync(privateFile, "utf8"),
        ),
      );
      return 0;
    }
    if (command === "check-list") {
      const publicFiles = flag(rest, "--public");
      const token = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--public");
      if (!publicFiles || !token) {
        out(USAGE);
        return 2;
      }
      const keys = publicFiles.split(",").map((f) => readFileSync(f, "utf8"));
      const result = explainList(token, keys);
      if (!result.ok) {
        out(`Refused: ${result.reason}`);
        return 1;
      }
      const { list } = result;
      out(`Sequence number: ${list.seq}`);
      out(`Made: ${list.issued}`);
      out(
        `Signed with: ${result.signedBy === 0 ? "the first key (current)" : `key number ${result.signedBy + 1} (next)`}`,
      );
      out(`Core: ${Object.values(list.core).join(", ") || "none"}`);
      out(`Plug-ins and themes: ${list.items.length}`);
      out(`Security warnings: ${(list.warnings ?? []).length}`);
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
