// A client's change to a live page (spec 11, section 4; decision D60), on SQLite and PostgreSQL: the Client may save a live page and
// keep it live but may not take it offline, the page as it was is kept, the designer is told once in half an hour, and the
// restore link shows what changed and puts it back. A link that is not right, or not for you, does nothing.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clientNoticeOn,
  describeClientEdit,
  ensureRestorePoint,
  listClientEdits,
  makeRestoreToken,
  NOTICE_EVERY_MS,
  readRestoreToken,
  recordClientEdit,
  restoreClientEdit,
  RESTORE_DAYS,
  saveClientNoticeOn,
} from "./client-edits.js";
import { createDraft, saveContent, type Actor } from "./content.js";
import {
  EMAIL_JOB,
  emailJobHandler,
  saveEmailSettings,
  type MakeTransport,
  type OutgoingEmail,
} from "./email.js";
import { drainJobs } from "./jobs.js";
import { DEFAULT_ROLES, ensureDefaultRoles } from "./roles.js";
import { SiteSecrets } from "./secret-box.js";
import { runSetup } from "./setup.js";

const T = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const para = (text: string) => ({
  id: "block-one",
  type: "paragraph",
  props: {},
  content: [{ type: "text", text }],
  children: [],
});
const actorFor = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (c) => caps.includes(c) };
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: a client's change to a live page`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor; // administrator, the designer
    let chloe: Actor; // client
    let eve: Actor; // editor
    let clock = T;
    const now = () => clock;
    const secrets = new SiteSecrets("x".repeat(40));
    let sent: OutgoingEmail[] = [];
    const accepting: MakeTransport = () => ({
      send: async (email) => {
        sent.push(email);
      },
    });
    const deliver = () =>
      drainJobs(
        db.runner,
        { [EMAIL_JOB]: emailJobHandler(db.runner, secrets, { makeTransport: accepting, now }) },
        { now },
      );

    const member = async (name: string, role: string) => {
      const id = newId();
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
        [id, name, `${name.toLowerCase()}@example.com`, new Date(T), new Date(T)],
      );
      const r = (
        await db.run(`select id from roles where site_id = ? and key = ?`, [siteId, role])
      )[0]!;
      await db.run(
        `insert into site_members (site_id, user_id, role_id, created_at) values (?, ?, ?, ?)`,
        [siteId, id, r["id"], new Date(T)],
      );
      return actorFor(id, role);
    };
    const livePage = async (title: string, text: string) => {
      const made = await createDraft(db.runner, anna, siteId, { type: "page", title }, now);
      if (!made.ok) throw new Error(made.message);
      const saved = await saveContent(
        db.runner,
        anna,
        siteId,
        made.id,
        {
          title,
          slugPart: made.slug,
          status: "published",
          blocks: [para(text)],
          revision: made.revision,
        },
        now,
      );
      if (!saved.ok) throw new Error(saved.message);
      return { id: made.id, slug: made.slug, revision: saved.revision };
    };
    /** What the entry route does when a client saves. */
    const clientSaves = async (
      id: string,
      slug: string,
      title: string,
      text: string,
      status = "published",
    ) => {
      const row = (await db.run(`select revision from entries where id = ?`, [id]))[0]!;
      const copyId = await ensureRestorePoint(db.runner, siteId, id, now);
      const saved = await saveContent(
        db.runner,
        chloe,
        siteId,
        id,
        { title, slugPart: slug, status, blocks: [para(text)], revision: Number(row["revision"]) },
        now,
      );
      if (!saved.ok) return { saved, copyId, noticed: { notified: 0 } };
      const noticed = await recordClientEdit(
        db.runner,
        secrets,
        {
          entryId: id,
          typeKey: "page",
          title,
          clientName: "Chloé",
          clientId: chloe.userId,
          copyId,
          revisionAfter: saved.revision,
          link: `https://garden.example/admin/pages/${id}`,
          siteName: "Anna's Garden",
          origin: "https://garden.example",
        },
        siteId,
        now,
      );
      return { saved, copyId, noticed };
    };
    const textOf = async (id: string) =>
      String((await db.run(`select plain_text from entries where id = ?`, [id]))[0]!["plain_text"]);
    const statusOf = async (id: string) =>
      String((await db.run(`select status from entries where id = ?`, [id]))[0]!["status"]);

    beforeEach(async () => {
      sent = [];
      clock = T;
      db = await open();
      const setup = await runSetup(
        db.runner,
        async ({ name, email }) => {
          const id = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, name, email, new Date(T), new Date(T)],
          );
          return { userId: id };
        },
        {
          siteName: "Anna's Garden",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      anna = actorFor(setup.userId, "administrator");
      chloe = await member("Chloe", "client");
      eve = await member("Eve", "editor");
      const saved = await saveEmailSettings(
        db.runner,
        anna,
        siteId,
        secrets,
        {
          host: "smtp.example.com",
          port: 587,
          security: "starttls",
          username: "u",
          password: "p",
          fromName: "Anna's Garden",
          fromAddress: "hello@annas-garden.example",
          testTo: "anna@example.com",
        },
        { makeTransport: accepting },
      );
      expect(saved.ok).toBe(true);
      sent = [];
    });
    afterEach(async () => db.close());

    describe("what a client may do to a live page", () => {
      test("save it and keep it live, at once", async () => {
        const page = await livePage("About us", "We grow roses.");
        const r = await clientSaves(page.id, page.slug, "About us", "We grow roses and tulips.");
        expect(r.saved).toMatchObject({ ok: true, status: "published" });
        expect(await statusOf(page.id)).toBe("published");
        expect(await textOf(page.id)).toContain("tulips");
      });

      test("not take it offline, hand it in for review, schedule it, or publish a draft (spec 02, section 7)", async () => {
        const page = await livePage("About us", "We grow roses.");
        for (const status of ["draft", "pending", "scheduled"]) {
          const r = await clientSaves(page.id, page.slug, "About us", "Changed", status);
          expect(r.saved, status).toMatchObject({ ok: false, code: "forbidden" });
        }
        expect(await statusOf(page.id)).toBe("published");
        expect(await textOf(page.id)).not.toContain("Changed");
        // A draft stays a draft for a client: it can be handed in for review but not published.
        const draft = await createDraft(
          db.runner,
          chloe,
          siteId,
          { type: "page", title: "My idea" },
          now,
        );
        if (!draft.ok) throw new Error(draft.message);
        const input = (status: string) => ({
          title: "My idea",
          slugPart: draft.slug,
          status,
          blocks: [para("x")],
          revision: draft.revision,
        });
        expect(
          await saveContent(db.runner, chloe, siteId, draft.id, input("published"), now),
        ).toMatchObject({ ok: false, code: "forbidden" });
        expect(
          (await saveContent(db.runner, chloe, siteId, draft.id, input("pending"), now)).ok,
        ).toBe(true);
      });

      test("a contributor, who may edit but not publish, cannot change a page that is live", async () => {
        const page = await livePage("About us", "We grow roses.");
        const cara = await member("Cara", "contributor");
        const r = await saveContent(
          db.runner,
          cara,
          siteId,
          page.id,
          {
            title: "About us",
            slugPart: page.slug,
            status: "published",
            blocks: [para("x")],
            revision: page.revision,
          },
          now,
        );
        expect(r).toMatchObject({ ok: false });
        expect(await statusOf(page.id)).toBe("published");
      });

      test("an editor, who may publish, can still take a live page offline", async () => {
        const page = await livePage("About us", "We grow roses.");
        const r = await saveContent(
          db.runner,
          eve,
          siteId,
          page.id,
          {
            title: "About us",
            slugPart: page.slug,
            status: "draft",
            blocks: [para("We grow roses.")],
            revision: page.revision,
          },
          now,
        );
        expect(r.ok).toBe(true);
        expect(await statusOf(page.id)).toBe("draft");
      });
    });

    describe("the page as it was is kept (the copy to go back to)", () => {
      test("the last saved copy is used when it is the page as it is; a new copy is made when it is not", async () => {
        const page = await livePage("About us", "We grow roses.");
        const revisions = async () =>
          Number(
            (await db.run(`select count(*) as n from entry_revisions where kind = 'revision'`))[0]![
              "n"
            ],
          );
        const before = await revisions();
        const first = await ensureRestorePoint(db.runner, siteId, page.id, now);
        expect(first).not.toBeNull();
        expect(await revisions()).toBe(before); // nothing new: the copy of the last save is the page
        // The page changed in a way no save recorded (for example by an import).
        await db.run(`update entries set title = 'About' where id = ?`, [page.id]);
        const second = await ensureRestorePoint(db.runner, siteId, page.id, now);
        expect(second).not.toBe(first);
        expect(await revisions()).toBe(before + 1);
        // And asking again does not make another.
        expect(await ensureRestorePoint(db.runner, siteId, page.id, now)).toBe(second);
        expect(await revisions()).toBe(before + 1);
        expect(await ensureRestorePoint(db.runner, siteId, newId(), now)).toBeNull();
      });
    });

    describe("the notice", () => {
      test("the designer is told, the client is not, and the line is in the log (AG-52)", async () => {
        const page = await livePage("About us", "We grow roses.");
        const r = await clientSaves(page.id, page.slug, "About us", "We grow roses and tulips.");
        expect(r.noticed.notified).toBe(1); // Anna; Eve has no say over the design
        await deliver();
        expect(sent).toHaveLength(1);
        expect(sent[0]!.to).toBe("anna@example.com");
        expect(sent[0]!.subject).toBe("Chloé changed a live page: About us");
        expect(sent[0]!.text).toContain("https://garden.example/admin/pages/");
        expect(sent[0]!.text).toMatch(
          /https:\/\/garden\.example\/admin\/restore\/[A-Za-z0-9_-]{40,}/,
        );
        const logged = await db.run(
          `select action, target_id from audit_log where action = 'content.client_edit'`,
        );
        expect(logged).toHaveLength(1);
        expect(logged[0]!["target_id"]).toBe(page.id);
      });

      test("one email for a page in half an hour, then another; another page is told at once", async () => {
        const a = await livePage("About us", "A");
        const b = await livePage("Contact", "B");
        expect((await clientSaves(a.id, a.slug, "About us", "A1")).noticed.notified).toBe(1);
        clock += 5 * 60 * 1000;
        expect((await clientSaves(a.id, a.slug, "About us", "A2")).noticed.notified).toBe(0);
        expect((await clientSaves(b.id, b.slug, "Contact", "B1")).noticed.notified).toBe(1);
        clock += NOTICE_EVERY_MS;
        expect((await clientSaves(a.id, a.slug, "About us", "A3")).noticed.notified).toBe(1);
        // Every change is in the log, announced or not.
        expect(
          await db.run(`select id from audit_log where action = 'content.client_edit'`),
        ).toHaveLength(4);
      });

      test("a save that changed nothing is not a change", async () => {
        const page = await livePage("About us", "We grow roses.");
        const r = await clientSaves(page.id, page.slug, "About us", "We grow roses.");
        expect(r.noticed.notified).toBe(0);
        expect(
          await db.run(`select id from audit_log where action = 'content.client_edit'`),
        ).toHaveLength(0);
      });

      test("with the notice turned off, or email not set up, nothing is sent but the line is kept", async () => {
        const page = await livePage("About us", "We grow roses.");
        expect(await clientNoticeOn(db.runner, siteId)).toBe(true);
        expect(await saveClientNoticeOn(db.runner, anna, siteId, false)).toEqual({
          ok: true,
          enabled: false,
        });
        expect(await clientNoticeOn(db.runner, siteId)).toBe(false);
        expect((await clientSaves(page.id, page.slug, "About us", "X1")).noticed.notified).toBe(0);
        await saveClientNoticeOn(db.runner, anna, siteId, true);
        // No email: the queue refuses.
        await db.run(`delete from settings where key = 'email'`);
        clock += NOTICE_EVERY_MS * 2;
        expect((await clientSaves(page.id, page.slug, "About us", "X2")).noticed.notified).toBe(0);
        expect(
          await db.run(`select id from audit_log where action = 'content.client_edit'`),
        ).toHaveLength(2);
      });

      test("only people who manage the settings change the notice, and only with a yes or a no", async () => {
        expect(await saveClientNoticeOn(db.runner, eve, siteId, false)).toMatchObject({
          ok: false,
          code: "forbidden",
        });
        expect(await saveClientNoticeOn(db.runner, anna, siteId, "no")).toMatchObject({
          ok: false,
          code: "invalid",
        });
        expect(await clientNoticeOn(db.runner, siteId)).toBe(true);
      });
    });

    describe("the restore link", () => {
      test("it shows what changed and changes nothing; the button puts the earlier version back and the page stays live", async () => {
        const page = await livePage("About us", "We grow roses.");
        const r = await clientSaves(page.id, page.slug, "About us", "We sell cars now.");
        await deliver();
        const token = /\/admin\/restore\/([A-Za-z0-9_-]+)/.exec(sent[0]!.text)![1]!;

        const seen = await describeClientEdit(db.runner, anna, siteId, secrets, token, now);
        if (!seen.ok) throw new Error(seen.message);
        expect(seen.view).toMatchObject({ entryId: page.id, title: "About us", savedSince: false });
        const lines = seen.view.compare.lines.map((l) => `${l.kind}:${l.text}`);
        expect(lines).toContain("removed:We grow roses.");
        expect(lines).toContain("added:We sell cars now.");
        // Looking changed nothing.
        expect(await textOf(page.id)).toContain("cars");
        expect(
          r.saved.ok &&
            (await db.run(`select revision from entries where id = ?`, [page.id]))[0]!["revision"],
        ).toBe(r.saved.ok ? r.saved.revision : -1);

        const done = await restoreClientEdit(db.runner, anna, siteId, secrets, token, now);
        expect(done).toMatchObject({ ok: true, entryId: page.id });
        expect(await textOf(page.id)).toContain("roses");
        expect(await textOf(page.id)).not.toContain("cars");
        expect(await statusOf(page.id)).toBe("published");
        // It is a save like any other, so it can itself be undone, and it is in the log and in the list.
        const copies = await db.run(
          `select summary from entry_revisions where entry_id = ? and kind = 'revision' order by created_at desc, id desc limit 1`,
          [page.id],
        );
        expect(String(copies[0]!["summary"])).toMatch(/Restored the copy from/);
        const [listed] = await listClientEdits(db.runner, anna, siteId);
        expect(listed).toMatchObject({ entryId: page.id, client: "Chloé", restored: true });
      });

      test("it says when the page was saved again after the client's change", async () => {
        const page = await livePage("About us", "We grow roses.");
        await clientSaves(page.id, page.slug, "About us", "We sell cars now.");
        await deliver();
        const token = /\/admin\/restore\/([A-Za-z0-9_-]+)/.exec(sent[0]!.text)![1]!;
        const row = (await db.run(`select revision from entries where id = ?`, [page.id]))[0]!;
        await saveContent(
          db.runner,
          anna,
          siteId,
          page.id,
          {
            title: "About us",
            slugPart: page.slug,
            status: "published",
            blocks: [para("Cars and bikes.")],
            revision: Number(row["revision"]),
          },
          now,
        );
        const seen = await describeClientEdit(db.runner, anna, siteId, secrets, token, now);
        expect(seen.ok && seen.view.savedSince).toBe(true);
      });

      test("a link that is wrong, changed, expired or for another site does nothing", async () => {
        const page = await livePage("About us", "We grow roses.");
        const r = await clientSaves(page.id, page.slug, "About us", "We sell cars now.");
        const token = makeRestoreToken(
          secrets,
          { entryId: page.id, copyId: r.copyId!, revisionAfter: 3 },
          now(),
        );
        expect(readRestoreToken(secrets, token, now())).toMatchObject({
          ok: true,
          entryId: page.id,
        });
        for (const bad of [
          "",
          "nonsense",
          token.slice(0, -4) + "AAAA",
          token.slice(0, 30) + (token[30] === "A" ? "B" : "A") + token.slice(31),
          makeRestoreToken(
            new SiteSecrets("y".repeat(40)),
            { entryId: page.id, copyId: r.copyId!, revisionAfter: 3 },
            now(),
          ),
        ])
          expect(readRestoreToken(secrets, bad, now()), bad.slice(0, 12)).toMatchObject({
            ok: false,
            message: "This restore link does not work.",
          });
        expect(readRestoreToken(secrets, token, now() + RESTORE_DAYS * DAY + 1)).toMatchObject({
          ok: false,
          message: expect.stringMatching(/expired/),
        });
        expect(
          await restoreClientEdit(db.runner, anna, siteId, secrets, token, () => now() + 15 * DAY),
        ).toMatchObject({ ok: false, code: "invalid" });
        expect(await textOf(page.id)).toContain("cars");
      });

      test("only people who may publish see or use it; a page that is gone says so", async () => {
        const page = await livePage("About us", "We grow roses.");
        const r = await clientSaves(page.id, page.slug, "About us", "We sell cars now.");
        const token = makeRestoreToken(
          secrets,
          { entryId: page.id, copyId: r.copyId!, revisionAfter: 2 },
          now(),
        );
        expect(
          await describeClientEdit(db.runner, chloe, siteId, secrets, token, now),
        ).toMatchObject({ ok: false, code: "forbidden" });
        expect(
          await restoreClientEdit(db.runner, chloe, siteId, secrets, token, now),
        ).toMatchObject({ ok: false, code: "forbidden" });
        expect(await listClientEdits(db.runner, chloe, siteId)).toEqual([]);
        expect(await textOf(page.id)).toContain("cars");
        // An editor may publish, so may restore.
        expect((await restoreClientEdit(db.runner, eve, siteId, secrets, token, now)).ok).toBe(
          true,
        );
        const gone = makeRestoreToken(
          secrets,
          { entryId: newId(), copyId: r.copyId!, revisionAfter: 2 },
          now(),
        );
        expect(await restoreClientEdit(db.runner, anna, siteId, secrets, gone, now)).toMatchObject({
          ok: false,
          code: "not_found",
        });
      });
    });

    describe("a site made before the Client could edit live pages", () => {
      const roleCaps = async () =>
        (
          await db.run(
            `select c.capability from role_capabilities c join roles r on r.id = c.role_id where r.site_id = ? and r.key = 'client'`,
            [siteId],
          )
        ).map((c) => String(c["capability"]));
      const drop = (capability: string) =>
        db.run(
          `delete from role_capabilities where capability = ? and role_id in (select id from roles where site_id = ? and key = 'client')`,
          [capability, siteId],
        );

      test("gets that one right the next time the roles are looked at, and nothing else changes", async () => {
        expect(await roleCaps()).toContain("content.edit_live");
        await drop("content.edit_live");
        const before = (await roleCaps()).sort();
        expect(before).not.toContain("content.edit_live");
        await ensureDefaultRoles(db.runner, siteId);
        expect((await roleCaps()).sort()).toEqual([...before, "content.edit_live"].sort());
        await ensureDefaultRoles(db.runner, siteId); // and only once
        expect((await roleCaps()).filter((c) => c === "content.edit_live")).toHaveLength(1);
      });

      test("a Client role the owner trimmed is left alone", async () => {
        await drop("content.edit_live");
        await drop("media.edit_any");
        await ensureDefaultRoles(db.runner, siteId);
        expect(await roleCaps()).not.toContain("content.edit_live");
      });
    });
  });
}
