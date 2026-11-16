// Spec 04 acceptance tests PL-01 to PL-29, PL-32, PL-35 to PL-38 on the real sandbox host (workerd, one process per
// plugin), with storage and the audit trail in SQLite and in PostgreSQL.
import { capabilitiesOf } from "@oks-page/auth";
import { checkBlocks } from "@oks-page/content-safety";
import { openers, type TestDb } from "@oks-page/db/testing";
import { createInstallService } from "./install.js";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxHost } from "./host.js";
import { developerMessage, ownerSentence, permissionWords } from "./permission-text.js";
import { isBlockedAddress } from "./safe-fetch.js";
import { PLUGINS } from "./testing/plugins.js";
import type { ActingUser, ContentEntry, DeveloperNote } from "./types.js";

const T = new Date(1_700_000_000_000);
const entry = (o: Record<string, unknown> = {}) => ({
  id: "e1",
  title: "T",
  plainText: "word ".repeat(450),
  meta: {},
  ...o,
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the plugin sandbox`, () => {
    let db: TestDb;
    let host: SandboxHost;
    let external: Server;
    let base = "";
    let externalPort = 0;
    const workDir = mkdtempSync(join(tmpdir(), "oks-sandbox-"));
    const developerNotes: DeveloperNote[] = [];
    const content = new Map<string, ContentEntry>([
      [
        "e1",
        { id: "e1", status: "published", title: "Hello", plainText: "one two three", meta: {} },
      ],
      [
        "draft1",
        { id: "draft1", status: "draft", title: "Secret draft", plainText: "x", meta: {} },
      ],
    ]);
    const SITE = "SITE0000000000000000000001";
    const OWNER = `USR${"owner".toUpperCase().padEnd(23, "0")}`;
    const extId = (key: string) =>
      `EXT${key
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .padEnd(23, "0")}`.slice(0, 26);
    const audit = async (action?: string) =>
      (
        await db.run(
          `select actor_id, action, detail from audit_log where actor_type = 'plugin'${action ? " and action = ?" : ""}`,
          action ? [action] : [],
        )
      ).map((r) => ({
        plugin: String(r["actor_id"]),
        action: String(r["action"]),
        detail:
          typeof r["detail"] === "string"
            ? JSON.parse(r["detail"])
            : (r["detail"] as Record<string, unknown>),
      }));

    beforeAll(async () => {
      db = await open();
      await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
        SITE,
        T,
        T,
      ]);
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, 'Owner', 'owner@example.com', ?, ?)",
        [OWNER, T, T],
      );
      for (const [key, p] of Object.entries(PLUGINS)) {
        await db.run(
          "insert into extensions (id, site_id, key, kind, version, tier, installed_at) values (?, ?, ?, 'plugin', '1.0.0', 'runtime', ?)",
          [extId(key), SITE, key, T],
        );
        // Installing a plugin grants the permissions it asked for at that time (spec 04, section 10, rule 1).
        for (const permission of p.manifest.permissions)
          await db.run(
            `insert into "extension_permissions" ("extension_id", "permission", "granted_by", "granted_at") values (?, ?, ?, ?)`,
            [extId(key), permission, OWNER, T],
          );
      }
      external = createServer((q, s) => {
        if (q.url === "/redirect") {
          s.writeHead(302, { location: base + "/ok" });
          return void s.end();
        }
        s.end("external-ok");
      });
      await new Promise<void>((r) => external.listen(0, "127.0.0.1", r));
      externalPort = (external.address() as { port: number }).port;
      base = `http://127.0.0.1:${externalPort}`;
      host = new SandboxHost({
        runner: db.runner,
        siteId: SITE,
        content: {
          get: async (id) => content.get(id) ?? null,
          update: async (id, patch) => {
            const e = content.get(id);
            if (!e) return null;
            Object.assign(e, patch);
            return e;
          },
        },
        workDir,
        wallMs: 1000,
        maxFailures: 3,
        storageLimitBytes: 50_000,
        memoryMb: 128,
        allowPrivateForTests: true,
        onDeveloperNote: (n) => developerNotes.push(n),
      });
      await host.listen();
      for (const [key, p] of Object.entries(PLUGINS)) host.load(p.manifest, p.code, extId(key));
    }, 60_000);

    afterAll(async () => {
      await host?.close();
      external?.close();
      await db?.close();
    });

    const hook = (id: string, name: string, event: unknown) => host.call(id, "hook", name, event);
    const blockCall = (id: string, name: string, props: unknown) =>
      host.call(id, "block", name, props);

    test("PL-01 a filter hook changes the entry (reading time)", async () => {
      const r = await hook("reading-time", "content:beforeSave", entry());
      expect(r.ok && (r.result as { meta: { readingTime: number } }).meta.readingTime).toBe(2);
    });

    test("PL-02 a warm call takes under 20 ms (median of 50)", async () => {
      const times: number[] = [];
      for (let i = 0; i < 50; i++)
        times.push((await hook("reading-time", "content:beforeSave", entry())).ms);
      times.sort((a, b) => a - b);
      console.log(
        `${kind}: warm call median ${times[25]} ms, max ${times[49]} ms, first start ${host.startMs("reading-time")} ms`,
      );
      expect(times[25]!).toBeLessThan(20);
    });

    test("PL-03 a hook the plugin does not define is skipped, not an error", async () => {
      const r = await hook("reading-time", "user:afterLogin", {});
      expect(r.ok && r.skipped).toBe(true);
    });

    test("PL-04 writing without content:write is refused with a plain message and a code; the data is unchanged", async () => {
      const r = await hook("no-write", "content:beforeSave", entry());
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(/content:write/);
      expect(!r.ok && r.code).toBe("permission_denied");
      expect(content.get("e1")!.title).toBe("Hello");
    });

    test("PL-05 reading a draft needs content:read_drafts, even with content:read", async () => {
      const r = await hook("drafts", "content:afterSave", {});
      expect(r.ok && r.result).toEqual({ pub: "Hello", draft: "permission_denied" });
    });

    test("PL-06 an endless loop is stopped at the time limit and the process is killed", async () => {
      const r = await hook("looper", "content:beforeSave", entry({ title: "LOOP" }));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.killed).toBe(true);
      expect(!r.ok && r.error).toBe("timeout");
      expect(r.ms).toBeLessThan(1800);
      expect(host.isRunning("looper")).toBe(false);
    });

    test("PL-07 another plugin keeps working while a bad one loops", async () => {
      const bad = hook("looper", "content:beforeSave", entry({ title: "LOOP" }));
      const good = await hook("reading-time", "content:beforeSave", entry());
      await bad;
      expect(good.ok).toBe(true);
      expect(good.ms).toBeLessThan(100);
    });

    test("PL-08 the killed plugin restarts on the next call", async () => {
      const r = await hook("looper", "content:beforeSave", entry({ title: "fine" }));
      expect(r.ok).toBe(true);
      console.log(`${kind}: restart ${host.startMs("looper")} ms`);
    });

    test("PL-09 three failures in a minute switch a plugin off and tell the owner", async () => {
      for (let i = 0; i < 3; i++) await hook("thrower", "content:beforeSave", entry());
      const r = await hook("thrower", "content:beforeSave", entry());
      expect(host.status("thrower")).toBe("switched_off");
      expect(!r.ok && r.skipped).toBe(true);
      expect(host.notices.some((n) => /Thrower was switched off/.test(n.message))).toBe(true);
      expect((await audit("runner.switched_off")).some((a) => a.plugin === "thrower")).toBe(true);
    });

    test.skipIf(
      !process.env["OKS_EXPECT_MEMORY_CAP"] &&
        new SandboxHost({
          runner: undefined as never,
          siteId: "",
          content: undefined as never,
          workDir: "",
          memoryMb: 128,
        }).memoryLimit === "none",
    )(
      "PL-10 a memory hog is killed by the memory cap (128 MB) and counted as a failure",
      async () => {
        expect(host.memoryLimit).not.toBe("none");
        const started = Date.now();
        const r = await hook("hog", "content:beforeSave", entry({ title: "HOG" }));
        console.log(
          `${kind}: memory hog stopped after ${Date.now() - started} ms (${host.memoryLimit})`,
        );
        expect(r.ok).toBe(false);
        expect(!r.ok && r.killed).toBe(true);
        expect((await audit("runner.failure")).filter((a) => a.plugin === "hog")).toHaveLength(1);
      },
      30_000,
    );

    test("PL-11 plugin storage stops at its limit with a storage_limit error", async () => {
      // The plugin writes until the limit stops it (about 12 writes). The test is about the limit, not about how fast
      // the database is: a database that stalls for a moment (a disk flush) must not turn this into a time-out.
      const r = await host.call("storer", "hook", "content:afterSave", {}, { timeoutMs: 15_000 });
      if (!r.ok) console.log("storer failed:", JSON.stringify(r));
      const out = r.ok ? (r.result as { stoppedAfter: number; code?: string }) : null;
      expect(out?.code).toBe("storage_limit");
      expect(out!.stoppedAfter).toBeGreaterThan(10);
      expect(out!.stoppedAfter).toBeLessThan(100);
    });

    test("PL-12 and PL-19 storage is kept apart per plugin, and key tricks stay in the plugin's own area", async () => {
      await hook("reading-time", "content:beforeSave", entry());
      const r = await hook("keeper", "content:afterSave", {});
      if (!r.ok) console.log("keeper failed:", JSON.stringify(r));
      expect(r.ok && r.result).toEqual({ tricky: "mine", notes: { hello: "world" } });
      const rows = await db.run(
        "select extension_id, collection, key from extension_storage where key like '%reading-time%'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!["extension_id"]).toBe(extId("keeper"));
      const owners = new Set(
        (await db.run("select extension_id from extension_storage")).map((x) => x["extension_id"]),
      );
      expect(owners).toEqual(new Set([extId("keeper"), extId("storer")]));
    });

    test("PL-13 network: only approved hosts, https only (http allowed here for tests), no redirects", async () => {
      const r = await hook("netter", "content:afterSave", { base });
      const o = r.ok ? (r.result as Record<string, string>) : {};
      expect(o["allowed host"]).toMatch(/^status 200 external-ok/);
      expect(o["not approved host"]).toBe("host_denied");
      expect(o["redirect"]).toBe("redirect");
      expect(o["file scheme"]).toBe("host_denied"); // no host in the address: not an approved host
    });

    test("PL-20 a hostile plugin block tree is repaired by the block checks (4 repairs)", async () => {
      const r = await blockCall("hostile-block", "hostile-block", {});
      expect(r.ok).toBe(true);
      const { body, repairs } = checkBlocks({ blocks: [r.ok ? r.result : null] });
      expect(body.blocks).toHaveLength(1);
      const block = body.blocks[0]!;
      expect(block.props.src).toBeUndefined();
      expect(block.props.color).toBeUndefined();
      expect(block.content).toEqual([{ type: "text", text: "x" }]);
      expect(repairs.sort()).toEqual(
        ["filled_missing_fields", "removed_color", "removed_link", "removed_url"].sort(),
      );
    });

    test("PL-21 a normal plugin block tree passes; only the missing block ID is added by the core", async () => {
      const r = await blockCall("reading-time", "reading-time", { minutes: 3 });
      expect(r.ok).toBe(true);
      const raw = r.ok ? r.result : null;
      const { body, repairs } = checkBlocks({ blocks: [raw] });
      expect(repairs).toEqual(["filled_missing_fields"]);
      expect(body.blocks).toHaveLength(1);
      const block = body.blocks[0]!;
      expect(block.type).toBe("paragraph");
      expect(block.props).toEqual({});
      expect(block.content).toEqual([{ type: "text", text: "3 min read" }]);
      expect(block.children).toEqual([]);
      expect(block.id.length).toBeGreaterThan(0);
    });

    test("PL-37 a plugin's content write passes the block checks, in the same call that writes it", async () => {
      const r = await hook("block-writer", "content:afterSave", {});
      expect(r.ok).toBe(true);
      const stored = content.get("e1")!.body!;
      expect(stored.blocks).toHaveLength(1);
      const block = stored.blocks[0] as { props: Record<string, unknown>; content: unknown };
      // The same repairs as PL-20: the unsafe src, color and link never reach the stored entry.
      expect(block.props["src"]).toBeUndefined();
      expect(block.props["color"]).toBeUndefined();
      expect(block.content).toEqual([{ type: "text", text: "x" }]);
      const rows = await audit("content.write_repaired");
      expect(rows.some((row) => row.plugin === "block-writer")).toBe(true);
    });

    describe("update and rollback", () => {
      const install = () => createInstallService(db.runner, host);
      const newCode = PLUGINS["reading-time"]!.code.replace(
        "Math.round(words / 200)",
        "Math.round(words / 100)",
      );

      test("PL-33 an update with a new permission is not applied until the owner approves", async () => {
        const extensionId = extId("reading-time");
        const svc = install();

        // Captured rather than assumed, so this test does not depend on what ran before it.
        const before = await hook("reading-time", "content:beforeSave", entry());
        const beforeTime =
          before.ok && (before.result as { meta: { readingTime: number } }).meta.readingTime;

        const result = await svc.update({
          extensionId,
          pluginId: "reading-time",
          version: "1.1.0",
          code: newCode,
          permissions: ["content:read", "content:write", "content:read_drafts"],
        });
        expect(result).toEqual({ applied: false, newPermissions: ["content:read_drafts"] });

        // The old code is still the one that runs: the result has not changed.
        const stillOld = await hook("reading-time", "content:beforeSave", entry());
        expect(
          stillOld.ok && (stillOld.result as { meta: { readingTime: number } }).meta.readingTime,
        ).toBe(beforeTime);

        const approved = await svc.approveUpdate({
          extensionId,
          pluginId: "reading-time",
          grantedBy: OWNER,
        });
        expect(approved).toBe(true);

        const after = await hook("reading-time", "content:beforeSave", entry());
        expect(
          after.ok && (after.result as { meta: { readingTime: number } }).meta.readingTime,
        ).toBe(5);

        const granted = await db.run(
          `select "permission" from "extension_permissions" where "extension_id" = ? order by "permission"`,
          [extensionId],
        );
        expect(granted.map((r) => r["permission"])).toEqual([
          "content:read",
          "content:read_drafts",
          "content:write",
        ]);
      });

      test("PL-34 rollback starts the previous bundle and keeps the plugin's data", async () => {
        // Runs its own two updates, so it does not depend on what PL-33 left behind: rollback
        // must restore the version right before the last one, whatever that happened to be.
        const extensionId = extId("reading-time");
        const svc = install();
        const codeA = PLUGINS["reading-time"]!.code.replace(
          "Math.round(words / 200)",
          "Math.round(words / 150)",
        );
        const codeB = PLUGINS["reading-time"]!.code.replace(
          "Math.round(words / 200)",
          "Math.round(words / 50)",
        );
        const permissions = ["content:read", "content:write"];

        const first = await svc.update({
          extensionId,
          pluginId: "reading-time",
          version: "2.0.0",
          code: codeA,
          permissions,
        });
        expect(first.applied).toBe(true);
        const afterA = await hook("reading-time", "content:beforeSave", entry());
        expect(
          afterA.ok && (afterA.result as { meta: { readingTime: number } }).meta.readingTime,
        ).toBe(3);

        const second = await svc.update({
          extensionId,
          pluginId: "reading-time",
          version: "2.1.0",
          code: codeB,
          permissions,
        });
        expect(second.applied).toBe(true);

        await db.run(
          `insert into "extension_storage" ("extension_id", "collection", "key", "value", "size_bytes", "updated_at")
           values (?, 'notes', 'k', '"kept across rollback"', 23, ?)
           on conflict ("extension_id", "collection", "key") do nothing`,
          [extensionId, T],
        );

        const afterB = await hook("reading-time", "content:beforeSave", entry());
        expect(
          afterB.ok && (afterB.result as { meta: { readingTime: number } }).meta.readingTime,
        ).toBe(9);

        const result = await svc.rollback({ extensionId, pluginId: "reading-time" });
        expect(result).toEqual({ ok: true });

        const rolledBack = await hook("reading-time", "content:beforeSave", entry());
        expect(
          rolledBack.ok &&
            (rolledBack.result as { meta: { readingTime: number } }).meta.readingTime,
        ).toBe(3);

        const storage = await db.run(
          `select "value" from "extension_storage" where "extension_id" = ? and "collection" = 'notes' and "key" = 'k'`,
          [extensionId],
        );
        expect(storage).toHaveLength(1);
      });

      test("rollback with nothing to roll back to says so", async () => {
        const result = await install().rollback({
          extensionId: extId("no-write"),
          pluginId: "no-write",
        });
        expect(result).toEqual({ ok: false, reason: "no_previous_version" });
      });
    });

    describe("a hostile plugin", () => {
      let R: Record<string, string> = {};
      beforeAll(async () => {
        const other = host.pid("reading-time");
        expect(other).toBeTruthy();
        const r = await hook("attacker", "content:afterSave", { otherPort: externalPort });
        R = r.ok ? (r.result as Record<string, string>) : {};
      });

      test("PL-14 the only environment value is its own token; no require", () => {
        expect(R["process.env"]).toBe('["TOKEN"]');
        expect(R["require"]).toBe("undefined");
      });
      test("PL-15 eval and new Function are refused", () => {
        expect(R["eval"]).toMatch(/blocked/);
        expect(R["new Function"]).toMatch(/blocked/);
      });
      test("PL-16 the internet, the cloud metadata address and other ports are unreachable", () => {
        for (const k of ["fetch internet", "fetch cloud metadata", "fetch other plugin directly"]) {
          expect(R[k], k).toMatch(/status 4|blocked/);
          expect(R[k], k).not.toMatch(/Example Domain|ami-id|external-ok/);
        }
      });
      test("PL-17 unknown host routes and calls with no or a wrong token are refused", () => {
        expect(R["fetch host admin route"]).toMatch(/status 40[34]/);
        expect(R["fetch host without token"]).toMatch(/status 403/);
        expect(R["guess other token"]).toMatch(/status 403/);
      });
      test("PL-18 prototype changes stay inside the plugin's own process", async () => {
        expect(R["prototype pollution"]).toMatch(/inside this process only/);
        expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
        const r = await hook("reading-time", "content:beforeSave", entry());
        expect(
          r.ok && (r.result as { meta: Record<string, unknown> }).meta["polluted"],
        ).toBeUndefined();
      });
      test("PL-22 every refused or unknown call is in the audit trail with the plugin's name", async () => {
        const entries = await audit();
        const denied = entries.filter((a) => /denied|unknown/.test(a.action));
        expect(denied.length).toBeGreaterThanOrEqual(4);
        expect(denied.every((a) => a.plugin.length > 0)).toBe(true);
        // A call with no valid token cannot be tied to a plugin: it is logged as an unknown caller.
        expect(
          denied.filter((a) => a.action === "host.unknown_caller").length,
        ).toBeGreaterThanOrEqual(2);
        expect(denied.some((a) => a.plugin === "no-write" && a.action === "host.denied")).toBe(
          true,
        );
      });
    });

    describe("a second hostile plugin", () => {
      let R: Record<string, string> = {};
      beforeAll(async () => {
        const r = await hook("attacker2", "content:afterSave", { hostDir: workDir, externalPort });
        R = r.ok ? (r.result as Record<string, string>) : {};
      });
      test("PL-25 the file system is virtual: no real host files can be read", () => {
        expect(R["fs read /etc/passwd"]).toMatch(/blocked/);
        expect(R["fs read the host's folder"]).toMatch(/blocked/);
        expect(R["fs list /"]).toBe('["bundle","tmp","dev"]');
      });
      test("PL-26 child_process does not work", () =>
        expect(R["node:child_process"]).toMatch(/not implemented/));
      test("PL-27 raw sockets to the loopback address are refused, and node:http lands on the host API, which refuses it", () => {
        expect(R["raw socket to the host"]).toMatch(/blocked/);
        expect(R["node:http request to the loopback"]).toMatch(/unknown caller/);
      });
    });

    test("PL-28 a plugin that calls process.exit only ends its own call, and counts as a failure", async () => {
      const r = await hook("exiter", "content:beforeSave", entry());
      expect(r.ok).toBe(false);
      expect((await audit("runner.failure")).filter((a) => a.plugin === "exiter")).toHaveLength(1);
      expect((await hook("reading-time", "content:beforeSave", entry())).ok).toBe(true);
    });

    test("PL-35 a bundle whose bytes changed is not run", async () => {
      const code = PLUGINS["reading-time"]!.code;
      host.load(
        {
          ...PLUGINS["reading-time"]!.manifest,
          id: "reading-time-signed",
          integrity: SandboxHost.hashOf(code),
        },
        code,
        extId("reading-time"),
      );
      expect((await hook("reading-time-signed", "content:beforeSave", entry())).ok).toBe(true);
      host.tamper("reading-time-signed", code + "\n// changed");
      const r = await hook("reading-time-signed", "content:beforeSave", entry());
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe("integrity");
    });

    test("PL-32 with no memory limit available, the host says so in plain words and offers build-time plugins only", () => {
      const none = new SandboxHost({
        runner: db.runner,
        siteId: SITE,
        content: undefined as never,
        workDir,
        memoryMb: 128,
        pretendNoMemoryLimit: true,
      });
      expect(none.memoryLimit).toBe("none");
      expect(none.limitsNote()).toMatch(/cannot limit the memory/);
      expect(none.limitsNote()).toMatch(/built into the site/);
    });

    describe("PL-36 a permission refusal is not a failure; the owner and the developer are told (ADR 0036)", () => {
      const limitedNotes = async () =>
        (await host.permissionNotes()).filter((n) => n.pluginId === "limited");
      const failures = async (plugin: string) =>
        (await audit("runner.failure")).filter((a) => a.plugin === plugin);

      test("PL-36a the owner gets one note for each plugin and permission, however many refusals, and it survives a restart", async () => {
        for (let i = 0; i < 3; i++) await hook("limited", "content:beforeSave", entry());
        await hook("limited", "content:afterSave", entry());

        const notes = await limitedNotes();
        expect(notes.map((n) => n.permission).sort()).toEqual([
          "content:read_drafts",
          "content:write",
        ]);
        const write = notes.find((n) => n.permission === "content:write")!;
        expect(write.message).toBe(
          "Limited needs the permission 'Change posts and pages when they are saved' but does not have it, so part of it does not work. Ask the author for an update.",
        );
        expect(write.count).toBe(4);
        expect(write.calls).toEqual([
          { kind: "hook", name: "content:beforeSave" },
          { kind: "hook", name: "content:afterSave" },
        ]);
        expect(write.firstAt).toBeGreaterThan(0);
        expect(write.firstAt).toBeLessThanOrEqual(write.lastAt);
        const drafts = notes.find((n) => n.permission === "content:read_drafts")!;
        expect(drafts.message).toMatch(/'Read your drafts and private content'/);
        expect(drafts.count).toBe(1);

        // The notes come from the audit trail, so a host that has just started shows the same ones.
        const restarted = new SandboxHost({
          runner: db.runner,
          siteId: SITE,
          content: undefined as never,
          workDir,
        });
        const again = (await restarted.permissionNotes()).filter((n) => n.pluginId === "limited");
        expect(again.map((n) => [n.permission, n.count]).sort()).toEqual(
          notes.map((n) => [n.permission, n.count]).sort(),
        );
      });

      test("PL-36a a network host that was not approved is a note too, shown by name", async () => {
        await hook("netter", "content:afterSave", { base });
        const notes = (await host.permissionNotes()).filter((n) => n.pluginId === "netter");
        // The address with no host name (file:///...) is refused but is not about a permission: no note for it.
        expect(notes.map((n) => n.permission)).toEqual(["network:fetch:localhost"]);
        // This plugin has no display name, so its id is used.
        expect(notes[0]!.message).toMatch(/^netter needs the permission 'Connect to localhost'/);
      });

      test("PL-36b the developer message has the hook, the exact permission and the fix", async () => {
        const seen = developerNotes.length;
        const message =
          'Hook "content:beforeSave" needs "content:write". Add it to "permissions" in the manifest.';
        const r = await hook("limited", "content:beforeSave", entry());
        expect(r.ok).toBe(false);
        expect(!r.ok && r.code).toBe("permission_denied");
        expect(!r.ok && r.error).toContain('permission "content:write" was not approved');
        expect(!r.ok && r.error).toContain(message);
        expect(r.permissionRefusals).toEqual([
          { permission: "content:write", code: "permission_denied", message },
        ]);
        expect(developerNotes.slice(seen)).toEqual([
          {
            pluginId: "limited",
            permission: "content:write",
            code: "permission_denied",
            message,
            call: { kind: "hook", name: "content:beforeSave" },
          },
        ]);
      });

      test("PL-36b a refusal the plugin catches is reported too, once for each permission", async () => {
        const r = await hook("limited", "content:afterSave", entry());
        expect(r.ok && r.result).toEqual({
          write: "permission_denied",
          draft: "permission_denied",
        });
        expect(r.permissionRefusals?.map((x) => x.permission)).toEqual([
          "content:write",
          "content:read_drafts",
        ]);
        expect(r.permissionRefusals?.[1]?.message).toBe(
          'Hook "content:afterSave" needs "content:read_drafts". Add it to "permissions" in the manifest.',
        );
      });

      test("PL-36c refusals do not switch the plugin off, and it keeps running", async () => {
        for (let i = 0; i < 4; i++) {
          const r = await hook("limited", "content:beforeSave", entry());
          expect(!r.ok && r.code).toBe("permission_denied");
        }
        expect(host.status("limited")).toBe("enabled");
        expect(await failures("limited")).toHaveLength(0);
        expect(host.notices.some((n) => n.pluginId === "limited")).toBe(false);
        expect((await hook("limited", "content:afterSave", entry())).ok).toBe(true);
      });

      test("PL-36c an error that only pretends to be a refusal still counts as a failure (three errors switch off: PL-09)", async () => {
        const r = await hook("limited", "user:afterLogin", {});
        expect(r.ok).toBe(false);
        expect(!r.ok && r.code).toBe("permission_denied");
        expect(r.permissionRefusals).toBeUndefined();
        expect(await failures("limited")).toHaveLength(1);
      });

      test("PL-36d PL-04 and PL-05 still hold: the hook runs, the write is refused, the data is unchanged", async () => {
        const r = await hook("no-write", "content:beforeSave", entry());
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toMatch(/content:write/);
        expect(!r.ok && r.code).toBe("permission_denied");
        expect(content.get("e1")!.title).toBe("Hello");
        const d = await hook("drafts", "content:afterSave", {});
        expect(d.ok && d.result).toEqual({ pub: "Hello", draft: "permission_denied" });
        expect(host.status("no-write")).toBe("enabled");
        expect(host.status("drafts")).toBe("enabled");
        const notes = await host.permissionNotes();
        expect(
          notes.some((n) => n.pluginId === "no-write" && n.permission === "content:write"),
        ).toBe(true);
        expect(
          notes.some((n) => n.pluginId === "drafts" && n.permission === "content:read_drafts"),
        ).toBe(true);
      });

      test("PL-36a once the owner approves the permission (an update), its note goes", async () => {
        const { manifest, code } = PLUGINS["limited"]!;
        host.load(
          { ...manifest, permissions: [...manifest.permissions, "content:write"] },
          code,
          extId("limited"),
        );
        expect((await limitedNotes()).map((n) => n.permission)).toEqual(["content:read_drafts"]);
        host.load(manifest, code, extId("limited"));
        expect(await limitedNotes()).toHaveLength(2);
      });
    });

    describe("PL-38 a plugin acting for a person may do only what both the plugin and the person may (spec 02, section 8)", () => {
      const user = (key: string) => `USR${key.toUpperCase().padEnd(23, "0")}`;
      const role = (key: string) => `ROL${key.toUpperCase().padEnd(23, "0")}`;
      const [AUTHOR, EDITOR, RECIPES, ADMIN, STRANGER, WRITER] = [
        "author",
        "editor",
        "recipes",
        "admin",
        "stranger",
        "writer",
      ].map(user) as [string, string, string, string, string, string];
      let as: Record<"author" | "editor" | "recipes" | "admin" | "stranger", ActingUser>;
      const act = (actingFor: ActingUser | undefined, event: Record<string, string>) =>
        host.call("acts-for", "hook", "content:afterSave", event, actingFor ? { actingFor } : {});

      beforeAll(async () => {
        for (const [id, name] of [
          [AUTHOR, "Author"],
          [EDITOR, "Editor"],
          [RECIPES, "Recipes"],
          [ADMIN, "Admin"],
          [STRANGER, "Stranger"],
          [WRITER, "Writer"],
        ])
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, name, `${name.toLowerCase()}@example.com`, T, T],
          );
        const caps: Record<string, (string | [string, string])[]> = {
          author: ["content.create", "content.edit_own", "content.publish_own"],
          editor: ["content.edit_any", "content.read_private", "content.publish_any"],
          recipes: [["content.edit_any", "recipe"]],
          administrator: [],
        };
        let n = 0;
        for (const [key, list] of Object.entries(caps)) {
          await db.run(
            "insert into roles (id, site_id, key, label, is_system, created_at) values (?, ?, ?, ?, ?, ?)",
            [role(key), SITE, key, key, true, T],
          );
          for (const c of list) {
            const [capability, scope] = Array.isArray(c) ? c : [c, ""];
            await db.run(
              "insert into role_capabilities (id, role_id, capability, scope_type_key) values (?, ?, ?, ?)",
              [`CAP${String(++n).padStart(23, "0")}`, role(key), capability, scope],
            );
          }
        }
        for (const [id, key] of [
          [AUTHOR, "author"],
          [EDITOR, "editor"],
          [RECIPES, "recipes"],
          [ADMIN, "administrator"],
        ])
          await db.run(
            "insert into site_members (site_id, user_id, role_id, created_at) values (?, ?, ?, ?)",
            [SITE, id, role(key!), T],
          );
        // The real lookup from the database, as the core will use it.
        as = {
          author: await capabilitiesOf(db.runner, SITE, AUTHOR),
          editor: await capabilitiesOf(db.runner, SITE, EDITOR),
          recipes: await capabilitiesOf(db.runner, SITE, RECIPES),
          admin: await capabilitiesOf(db.runner, SITE, ADMIN),
          stranger: await capabilitiesOf(db.runner, SITE, STRANGER),
        };
        const put = (e: ContentEntry) => content.set(e.id, e);
        put({
          id: "mine",
          status: "draft",
          title: "Mine",
          authorId: AUTHOR,
          typeKey: "post",
          meta: {},
        });
        put({
          id: "theirs",
          status: "draft",
          title: "Theirs",
          authorId: WRITER,
          typeKey: "post",
          meta: {},
        });
        put({
          id: "pub-theirs",
          status: "published",
          title: "Their post",
          authorId: WRITER,
          typeKey: "post",
          meta: {},
        });
        put({
          id: "recipe1",
          status: "published",
          title: "Their recipe",
          authorId: WRITER,
          typeKey: "recipe",
          meta: {},
        });
      });

      test("PL-38 for an Author: their own draft may be read and changed", async () => {
        const r = await act(as.author, { read: "mine", write: "mine" });
        expect(r.ok && r.result).toEqual({ read: "allowed", write: "allowed" });
      });

      test("PL-38 for an Author: someone else's draft cannot be read and their post cannot be changed; the data is unchanged", async () => {
        const r = await act(as.author, { read: "theirs", write: "pub-theirs" });
        expect(r.ok && r.result).toEqual({ read: "user_denied", write: "user_denied" });
        expect(content.get("pub-theirs")!.title).toBe("Their post");
        expect(r.permissionRefusals?.map((x) => [x.code, x.permission])).toEqual([
          ["user_denied", "content.read_private"],
          ["user_denied", "content.edit_any"],
        ]);
        expect(r.permissionRefusals?.[0]?.message).toMatch(/never gets more power than the person/);
      });

      test("PL-38 for an Editor: anyone's entries may be read and changed", async () => {
        const r = await act(as.editor, { read: "theirs", write: "pub-theirs" });
        expect(r.ok && r.result).toEqual({ read: "allowed", write: "allowed" });
        content.get("pub-theirs")!.title = "Their post";
      });

      test("PL-38 a role limited to recipes changes recipes, not posts", async () => {
        const ok = await act(as.recipes, { write: "recipe1" });
        expect(ok.ok && ok.result).toEqual({ write: "allowed" });
        const r = await act(as.recipes, { write: "pub-theirs" });
        expect(r.ok && r.result).toEqual({ write: "user_denied" });
      });

      test("PL-38 someone who is not a member may let the plugin read what is published, and nothing more", async () => {
        const r = await act(as.stranger, { read: "pub-theirs", write: "pub-theirs" });
        expect(r.ok && r.result).toEqual({ read: "allowed", write: "user_denied" });
        const d = await act(as.stranger, { read: "mine" });
        expect(d.ok && d.result).toEqual({ read: "user_denied" });
      });

      test("PL-38 a person's power never extends the plugin's: acting for an Administrator, a plugin without the permission is still refused", async () => {
        const r = await host.call(
          "limited",
          "hook",
          "content:afterSave",
          {},
          { actingFor: as.admin },
        );
        expect(r.ok && r.result).toEqual({
          write: "permission_denied",
          draft: "permission_denied",
        });
      });

      test("PL-38 acting alone (a job, no person), only the plugin's own permissions apply", async () => {
        const r = await act(undefined, { read: "theirs", write: "pub-theirs" });
        expect(r.ok && r.result).toEqual({ read: "allowed", write: "allowed" });
        content.get("pub-theirs")!.title = "Their post";
      });

      test("PL-38 a person's refusal is no failure and no note for the owner, and it is in the audit trail", async () => {
        for (let i = 0; i < 4; i++) {
          const r = await host.call(
            "acts-for",
            "hook",
            "content:beforeSave",
            { write: "pub-theirs" },
            { actingFor: as.author },
          );
          expect(r.ok).toBe(false);
          expect(!r.ok && r.code).toBe("user_denied");
        }
        expect(host.status("acts-for")).toBe("enabled");
        expect((await host.permissionNotes()).some((n) => n.pluginId === "acts-for")).toBe(false);
        const rows = (await audit("host.denied_user")).filter((a) => a.plugin === "acts-for");
        expect(rows.length).toBeGreaterThanOrEqual(4);
        expect(rows.every((a) => a.detail["user"] !== undefined)).toBe(true);
        expect(
          rows.some((a) => a.detail["user"] === AUTHOR && a.detail["need"] === "content.edit_any"),
        ).toBe(true);
        expect(content.get("pub-theirs")!.title).toBe("Their post");
      });
    });
  });
}

describe("PL-36 the words for a refused permission", () => {
  test("the owner reads the plain sentence from spec 04, section 4.2; a host is shown by name", () => {
    expect(permissionWords("content:write")).toBe("Change posts and pages when they are saved");
    expect(permissionWords("comments:moderate")).toBe("Read or moderate comments");
    expect(permissionWords("network:fetch:api.example.com")).toBe("Connect to api.example.com");
    expect(permissionWords("something:new")).toBe("something:new");
    expect(ownerSentence("Reading Time", "content:write")).toBe(
      "Reading Time needs the permission 'Change posts and pages when they are saved' but does not have it, so part of it does not work. Ask the author for an update.",
    );
  });
  test("the developer message says Hook or Block, and still reads well when the call is over", () => {
    expect(developerMessage({ kind: "hook", name: "content:beforeSave" }, "content:write")).toBe(
      'Hook "content:beforeSave" needs "content:write". Add it to "permissions" in the manifest.',
    );
    expect(developerMessage({ kind: "block", name: "reading-time" }, "content:read")).toBe(
      'Block "reading-time" needs "content:read". Add it to "permissions" in the manifest.',
    );
    expect(developerMessage(undefined, "content:read")).toBe(
      'This call needs "content:read". Add it to "permissions" in the manifest.',
    );
  });
});

describe("PL-29 addresses a plugin may not reach", () => {
  test.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.9",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "224.0.0.1",
  ])("%s is refused", (a) => {
    expect(isBlockedAddress(a)).toBe(true);
  });
  test.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"])(
    "%s is allowed",
    (a) => {
      expect(isBlockedAddress(a)).toBe(false);
    },
  );
  test("a text that is not an address is refused", () =>
    expect(isBlockedAddress("not-an-ip")).toBe(true));
});
