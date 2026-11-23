// Privacy requests (spec 18, section 5; spec 16, FM-08): finding, exporting and deleting what the site keeps for an email
// address: the plugins' declared data with its files, the email log, and the account (only reported). In SQLite and
// PostgreSQL, with real stored data. Nothing but counts and a hash of the address goes to the audit log.
import type { Actor } from "@oks-page/core";
import { openers, type TestDb } from "@oks-page/db/testing";
import { inflateRawSync } from "node:zlib";
import { beforeEach, describe, expect, test } from "vitest";
import {
  deletePersonalData,
  emailHash,
  exportPersonalData,
  findPersonalData,
  normalizeEmail,
} from "./privacy-requests";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000141";
const EXT = "EXT00000000000000000000141";
const EXT_OFF = "EXT00000000000000000000142";
const EXT_BAD = "EXT00000000000000000000143";
const USER = "USER0000000000000000000141";
const ROLE = "ROLE0000000000000000000141";
const fid = (n: number) => `FILE${String(n).padStart(22, "0")}`;

const admin: Actor = { userId: USER, can: (c) => c === "settings.manage" };
const editor: Actor = { userId: USER, can: () => false };

const DECLARED = [
  {
    id: "form-messages",
    label: "Form messages",
    source: "storage:messages",
    match: ["emails"],
    show: [
      { field: "at", label: "Received", format: "datetime" },
      { field: "summary", label: "Message" },
    ],
  },
];

/** The files of a zip, read from its local headers (the site writes the sizes there). */
function unzip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let at = 0;
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const method = zip.readUInt16LE(at + 8);
    const packed = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const extra = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString("utf8");
    const body = zip.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + packed);
    out.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));
    at += 30 + nameLength + extra + packed;
  }
  return out;
}

describe("the address", () => {
  test("is read in one plain form, and what is not an address is refused", () => {
    expect(normalizeEmail("  Anna@Example.COM ")).toBe("anna@example.com");
    for (const bad of [
      "",
      "anna",
      "anna@",
      "@example.com",
      "a b@example.com",
      "a@b",
      null,
      5,
      "x".repeat(250) + "@example.com",
    ])
      expect(normalizeEmail(bad)).toBeNull();
    expect(emailHash("anna@example.com")).toMatch(/^[0-9a-f]{64}$/);
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: privacy requests`, () => {
    let db: TestDb;
    const put = (ext: string, key: string, value: unknown) =>
      db.run(
        `insert into extension_storage (extension_id, collection, key, value, size_bytes, updated_at) values (?, 'messages', ?, ?, 10, ?)`,
        [ext, key, JSON.stringify(value), T],
      );
    const file = (n: number, ext: string, key: string, bytes: number[]) =>
      db.run(
        `insert into extension_files (id, extension_id, name, mime, size_bytes, sha256, status, collection, key, data, created_at) values (?, ?, ?, 'application/pdf', ?, 'x', 'kept', 'messages', ?, ?, ?)`,
        [fid(n), ext, `cv-${n}.pdf`, bytes.length, key, Buffer.from(bytes), T],
      );
    const mail = (n: number, to: string) =>
      db.run(
        `insert into email_log (id, site_id, email_key, to_address, subject, provider, status, attempts, created_at) values (?, ?, 'k', ?, ?, 'smtp', 'sent', 1, ?)`,
        [`MAIL${String(n).padStart(22, "0")}`, SITE, to, `Subject ${n}`, T],
      );
    const count = async (table: string) =>
      Number((await db.runner.all(`select count(*) as "n" from ${table}`))[0]!["n"]);

    beforeEach(async () => {
      db = await open();
      await db.run(
        "insert into sites (id, name, created_at, updated_at) values (?, 'Anna''s Garden', ?, ?)",
        [SITE, T, T],
      );
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, 'Anna', 'Anna@Example.com', ?, ?)",
        [USER, T, T],
      );
      await db.run(
        "insert into roles (id, site_id, key, label, is_system, created_at) values (?, ?, 'administrator', 'Administrator', ?, ?)",
        [ROLE, SITE, true, T],
      );
      await db.run(
        "insert into site_members (site_id, user_id, role_id, created_at) values (?, ?, ?, ?)",
        [SITE, USER, ROLE, T],
      );
      const ext = (id: string, key: string, status: string, manifest: unknown) =>
        db.run(
          "insert into extensions (id, site_id, key, kind, version, tier, status, manifest, installed_at) values (?, ?, ?, 'plugin', '1.0.0', 'runtime', ?, ?, ?)",
          [id, SITE, key, status, JSON.stringify(manifest), T],
        );
      await ext(EXT, "forms", "enabled", { personalData: DECLARED });
      // A plugin that is switched off still keeps data; one with a damaged declaration is not looked into.
      await ext(EXT_OFF, "old-forms", "disabled", { personalData: DECLARED });
      await ext(EXT_BAD, "broken", "enabled", {
        personalData: [{ id: "x", source: "elsewhere", match: [] }],
      });
      await put(EXT, "1", {
        emails: ["anna@example.com"],
        at: 1_700_000_000_000,
        summary: "Name: Anna",
        title: "Contact",
      });
      await put(EXT, "2", {
        emails: ["ben@example.com"],
        at: 1_700_000_100_000,
        summary: "Name: Ben",
      });
      await put(EXT, "3", {
        emails: ["Anna@Example.com ", "other@example.com"],
        at: 1_700_000_200_000,
        summary: "Name: Anna again",
      });
      await put(EXT, "4", { summary: "No address here" });
      await put(EXT_OFF, "1", {
        emails: "ANNA@example.com",
        at: 1_700_000_300_000,
        summary: "From the old plugin",
      });
      await put(EXT_BAD, "1", { emails: ["anna@example.com"], summary: "Never looked into" });
      await file(1, EXT, "1", [0, 255, 128, 10, 13, 65]);
      await file(2, EXT, "2", [9, 9, 9]);
      await file(3, EXT, "3", [1, 2, 3, 4]);
      await mail(1, "anna@example.com");
      await mail(2, "Anna@example.com");
      await mail(3, "ben@example.com");
    });

    test("finding lists everything linked to the address, whatever the capitals, and nothing about anybody else", async () => {
      const r = await findPersonalData(db.runner, admin, SITE, "  ANNA@example.com ");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.result.email).toBe("anna@example.com");
      const byLabel = Object.fromEntries(r.result.groups.map((g) => [g.label, g]));
      expect(Object.keys(byLabel).sort()).toEqual([
        "Emails the site sent to this address",
        "Form messages (forms)",
        "Form messages (old-forms)",
        "User account",
      ]);
      const forms = byLabel["Form messages (forms)"]!;
      expect(forms.total).toBe(2);
      expect(forms.items.map((i) => i.key)).toEqual(["1", "3"]);
      expect(forms.items[0]!.cells).toEqual([
        { label: "Received", text: "2023-11-14 22:13 UTC" },
        { label: "Message", text: "Name: Anna" },
      ]);
      expect(forms.items[0]!.files.map((f) => f.name)).toEqual(["cv-1.pdf"]);
      expect(forms.items[1]!.files.map((f) => f.name)).toEqual(["cv-3.pdf"]);
      // The switched-off plugin's data is found too; the damaged declaration finds nothing.
      expect(byLabel["Form messages (old-forms)"]!.total).toBe(1);
      expect(byLabel["Emails the site sent to this address"]!.total).toBe(2);
      // An account is reported and never deletable here.
      expect(byLabel["User account"]).toMatchObject({ deletable: false, total: 1 });
      expect(r.result.deletable).toBe(2 + 1 + 2);
      expect(JSON.stringify(r.result)).not.toContain("Ben");
      expect(JSON.stringify(r.result)).not.toContain("Never looked into");
    });

    test("an address nobody used finds nothing, a bad address and a person without the right are refused", async () => {
      const none = await findPersonalData(db.runner, admin, SITE, "nobody@example.com");
      expect(none.ok && none.result.groups).toEqual([]);
      const bad = await findPersonalData(db.runner, admin, SITE, "not an address");
      expect(!bad.ok && bad.code).toBe("invalid");
      for (const f of [findPersonalData, exportPersonalData, deletePersonalData] as const) {
        const r = await f(db.runner, editor, SITE, "anna@example.com");
        expect(!r.ok && r.code).toBe("forbidden");
      }
      expect(await count("extension_storage")).toBe(6);
    });

    test("the export is a ZIP of readable files with the files that were sent, and nobody else's data", async () => {
      const r = await exportPersonalData(db.runner, admin, SITE, "anna@example.com");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.filename).toMatch(/^personal-data-[0-9a-f]{10}\.zip$/);
      expect(r.items).toBe(2 + 1 + 2);
      expect(r.files).toBe(2);
      const zip = unzip(r.zip);
      expect([...zip.keys()].sort()).toEqual([
        "README.txt",
        "account.json",
        "email-log.json",
        `plugins/forms/files/${fid(1)}-cv-1.pdf`,
        `plugins/forms/files/${fid(3)}-cv-3.pdf`,
        "plugins/forms/form-messages.json",
        "plugins/old-forms/form-messages.json",
      ]);
      // The files come back byte for byte.
      expect([...zip.get(`plugins/forms/files/${fid(1)}-cv-1.pdf`)!]).toEqual([
        0, 255, 128, 10, 13, 65,
      ]);
      const messages = JSON.parse(
        zip.get("plugins/forms/form-messages.json")!.toString("utf8"),
      ) as {
        key: string;
        data: { summary: string };
        files: string[];
      }[];
      expect(messages.map((m) => [m.key, m.data.summary, m.files.length])).toEqual([
        ["1", "Name: Anna", 1],
        ["3", "Name: Anna again", 1],
      ]);
      expect(JSON.parse(zip.get("account.json")!.toString("utf8"))).toMatchObject({
        name: "Anna",
        email: "Anna@Example.com",
      });
      expect(zip.get("README.txt")!.toString("utf8")).toContain(
        "Personal data kept by Anna's Garden for anna@example.com",
      );
      const everything = [...zip.values()].map((b) => b.toString("latin1")).join("");
      expect(everything).not.toContain("Name: Ben");
      expect(everything).not.toContain("ben@example.com");
    });

    test("deleting removes the items with their files and the email records, and leaves everyone else and the account", async () => {
      const r = await deletePersonalData(db.runner, admin, SITE, "Anna@example.com");
      expect(r.ok && [r.items, r.files, r.emails, r.account]).toEqual([3, 2, 2, true]);
      const left = (
        await db.runner.all(
          `select "extension_id", "key" from extension_storage order by "extension_id", "key"`,
        )
      ).map((x) => `${String(x["extension_id"]).slice(-3)}:${String(x["key"])}`);
      expect(left).toEqual(["141:2", "141:4", "143:1"]);
      expect(
        (await db.runner.all(`select "id" from extension_files`)).map((x) => String(x["id"])),
      ).toEqual([fid(2)]);
      expect(
        (await db.runner.all(`select "to_address" from email_log`)).map((x) =>
          String(x["to_address"]),
        ),
      ).toEqual(["ben@example.com"]);
      expect(await count("users")).toBe(1);
      // Again: nothing more to delete, and it can no longer be found.
      const again = await deletePersonalData(db.runner, admin, SITE, "anna@example.com");
      expect(again.ok && [again.items, again.files, again.emails]).toEqual([0, 0, 0]);
      const found = await findPersonalData(db.runner, admin, SITE, "anna@example.com");
      expect(found.ok && found.result.groups.map((g) => g.kind)).toEqual(["account"]);
    });

    test("every request is in the audit log, with a hash and counts and never the address or the data", async () => {
      await findPersonalData(db.runner, admin, SITE, "anna@example.com");
      await exportPersonalData(db.runner, admin, SITE, "anna@example.com");
      await deletePersonalData(db.runner, admin, SITE, "anna@example.com");
      const log = await db.runner.all(
        `select "action", "target_id", "detail" from audit_log where site_id = ? order by created_at, id`,
        [SITE],
      );
      expect(log.map((l) => l["action"])).toEqual([
        "privacy.find",
        "privacy.export",
        "privacy.delete",
      ]);
      for (const l of log) expect(String(l["target_id"])).toBe(emailHash("anna@example.com"));
      const text = JSON.stringify(log);
      expect(text).not.toContain("anna@example.com");
      expect(text).not.toContain("Anna");
      expect(
        typeof log[2]!["detail"] === "string"
          ? JSON.parse(String(log[2]!["detail"]))
          : log[2]!["detail"],
      ).toMatchObject({
        items: 3,
        files: 2,
        emails: 2,
        accountLeft: true,
      });
    });
  });
}
