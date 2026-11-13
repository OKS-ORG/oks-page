import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup, type CreateAccount } from "./setup.js";
import {
  INVITES_MAX_PENDING,
  PASSWORD_MIN,
  acceptInvitation,
  changeMemberRole,
  createInvitation,
  listInvitations,
  listMembers,
  listRoles,
  readInvitation,
  removeMember,
  revokeInvitation,
} from "./users.js";

const T = new Date(1_700_000_000_000);
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: people and invitations`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor; // the administrator who set the site up
    let annaId = "";

    /** The way the real site makes an account: a row in `users`; a taken email is refused. */
    const createAccount: CreateAccount = async ({ name, email }) => {
      const taken = await db.run("select 1 from users where email = ?", [email]);
      if (taken.length > 0) throw new Error("This email is already in use.");
      const id = newId();
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
        [id, name, email, T, T],
      );
      return { userId: id };
    };

    const addMember = async (name: string, email: string, role: string) => {
      const { userId } = await createAccount({ name, email, password: "x" });
      const roleRow = await db.run("select id from roles where key = ?", [role]);
      await db.run(
        "insert into site_members (site_id, user_id, role_id, created_at) values (?, ?, ?, ?)",
        [siteId, userId, String(roleRow[0]!["id"]), new Date(NOW)],
      );
      return userId;
    };

    beforeEach(async () => {
      db = await open();
      const setup = await runSetup(db.runner, createAccount, {
        siteName: "S",
        admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
      });
      siteId = setup.siteId;
      annaId = setup.userId;
      anna = actorOf(annaId, "administrator");
    });
    afterEach(async () => {
      await db.close();
    });

    const invite = (input: object = {}, who = anna, now = NOW) =>
      createInvitation(
        db.runner,
        who,
        siteId,
        { name: "Eli", email: "eli@example.com", roleKey: "editor", ...input } as never,
        now,
      );

    describe("the members", () => {
      test("the list shows each person with their role, and the roles to choose from", async () => {
        const members = await listMembers(db.runner, siteId);
        expect(members).toMatchObject([
          {
            userId: annaId,
            name: "Anna",
            email: "anna@example.com",
            roleKey: "administrator",
            twoFactor: false,
          },
        ]);
        expect((await listRoles(db.runner, siteId)).map((r) => r.key).sort()).toEqual([
          "administrator",
          "author",
          "contributor",
          "editor",
          "subscriber",
        ]);
      });

      test("changing a role, and who may", async () => {
        const eli = await addMember("Eli", "eli@example.com", "editor");
        expect(await changeMemberRole(db.runner, anna, siteId, eli, "author")).toMatchObject({
          ok: true,
        });
        expect((await listMembers(db.runner, siteId)).find((m) => m.userId === eli)!.roleKey).toBe(
          "author",
        );
        expect(await changeMemberRole(db.runner, anna, siteId, eli, "wizard")).toMatchObject({
          ok: false,
          code: "invalid",
        });
        expect(await changeMemberRole(db.runner, anna, siteId, newId(), "author")).toMatchObject({
          ok: false,
          code: "not_found",
        });
        expect(
          await changeMemberRole(db.runner, actorOf(eli, "editor"), siteId, eli, "administrator"),
        ).toMatchObject({ ok: false, code: "forbidden" });
      });

      test("the last administrator cannot be demoted or removed (AU-40); another administrator makes it possible", async () => {
        expect(await changeMemberRole(db.runner, anna, siteId, annaId, "editor")).toMatchObject({
          ok: false,
          code: "conflict",
        });
        const bo = await addMember("Bo", "bo@example.com", "editor");
        expect(await removeMember(db.runner, anna, siteId, annaId)).toMatchObject({
          ok: false,
          code: "conflict",
        }); // yourself
        await changeMemberRole(db.runner, anna, siteId, bo, "administrator");
        const bob = actorOf(bo, "administrator");
        // Two administrators: one may step down.
        expect(await changeMemberRole(db.runner, anna, siteId, annaId, "editor")).toMatchObject({
          ok: true,
        });
        // Bo is now the only one: Bo cannot be demoted, and Anna (an editor now) may not do anything.
        expect(await changeMemberRole(db.runner, bob, siteId, bo, "editor")).toMatchObject({
          ok: false,
          code: "conflict",
        });
        expect(await removeMember(db.runner, actorOf(annaId, "editor"), siteId, bo)).toMatchObject({
          ok: false,
          code: "forbidden",
        });
        expect(
          (await listMembers(db.runner, siteId)).filter((m) => m.roleKey === "administrator"),
        ).toHaveLength(1);
      });

      test("removing a person takes them out of the site and keeps their account and their work", async () => {
        const eli = await addMember("Eli", "eli@example.com", "editor");
        await db.run(
          `insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, plain_text, html, seo, meta, created_at, updated_at)
           values (?, ?, 'post', 'published', 'Eli post', 'blog/eli', ?, '{}', '{"version":1,"blocks":[]}', '', '', '{}', '{}', ?, ?)`,
          [newId(), siteId, eli, T, T],
        );
        expect(await removeMember(db.runner, anna, siteId, eli)).toMatchObject({ ok: true });
        expect((await listMembers(db.runner, siteId)).map((m) => m.userId)).toEqual([annaId]);
        expect(await db.run("select 1 from users where id = ?", [eli])).toHaveLength(1);
        expect(await db.run("select 1 from entries where author_id = ?", [eli])).toHaveLength(1);
        expect(await removeMember(db.runner, anna, siteId, eli)).toMatchObject({
          ok: false,
          code: "not_found",
        });
        expect(await removeMember(db.runner, actorOf(annaId, "editor"), siteId, eli)).toMatchObject(
          { ok: false, code: "forbidden" },
        );
      });
    });

    describe("an invitation", () => {
      test("is made, listed without its link, and read by the person who has the link", async () => {
        const made = await invite();
        if (!made.ok) throw new Error(made.message);
        expect(made.token.length).toBeGreaterThanOrEqual(30);
        expect(made.invitation).toMatchObject({
          name: "Eli",
          email: "eli@example.com",
          roleKey: "editor",
          invitedBy: annaId,
          expiresAt: NOW + 7 * DAY,
        });
        expect(await listInvitations(db.runner, siteId, NOW)).toHaveLength(1);
        // The database holds a hash, never the link.
        const stored = JSON.stringify(
          await db.run("select value from settings where key = 'invitations'"),
        );
        expect(stored).not.toContain(made.token);
        const read = await readInvitation(db.runner, siteId, made.token, NOW);
        expect(read).toMatchObject({
          email: "eli@example.com",
          roleKey: "editor",
          roleLabel: "Editor",
        });
        // Wrong, short and long links read nothing.
        for (const bad of [
          "",
          "x",
          made.token.slice(0, -1) + "A",
          made.token + "A",
          "a".repeat(101),
        ])
          expect(await readInvitation(db.runner, siteId, bad, NOW), bad).toBeNull();
      });

      test("the email is lower-cased, and the days may be 1 to 30", async () => {
        const made = await invite({ email: " ELI@Example.COM ", days: 30 });
        if (!made.ok) throw new Error(made.message);
        expect(made.invitation.email).toBe("eli@example.com");
        expect(made.invitation.expiresAt).toBe(NOW + 30 * DAY);
        for (const bad of [0, 31, 1.5, Number.NaN])
          expect(
            await invite({ email: `x${bad}@example.com`, days: bad }),
            String(bad),
          ).toMatchObject({ ok: false, field: "days" });
      });

      test("refusals, each with its field and a plain message", async () => {
        const refuse = async (input: object, field: string, code = "invalid") =>
          expect(await invite(input), JSON.stringify(input)).toMatchObject({
            ok: false,
            code,
            field,
          });
        await refuse({ name: "  " }, "name");
        await refuse({ name: "x".repeat(101) }, "name");
        await refuse({ email: "not-an-email" }, "email");
        await refuse({ email: "" }, "email");
        await refuse({ roleKey: "wizard" }, "role");
        await refuse({ email: "anna@example.com" }, "email", "conflict"); // already has an account
        expect(await invite({}, actorOf(annaId, "editor"))).toMatchObject({
          ok: false,
          code: "forbidden",
        });
        expect(await invite()).toMatchObject({ ok: true });
        await refuse({ email: "Eli@example.com" }, "email", "conflict"); // already invited
        expect(await listInvitations(db.runner, siteId, NOW)).toHaveLength(1);
      });

      test("at most 100 wait at once, and expired ones do not count", async () => {
        for (let n = 0; n < INVITES_MAX_PENDING; n++)
          expect(await invite({ email: `p${n}@example.com`, days: 1 })).toMatchObject({ ok: true });
        expect(await invite({ email: "one-too-many@example.com" })).toMatchObject({
          ok: false,
          code: "conflict",
        });
        // A day and a bit later they have expired, and there is room again.
        expect(await invite({ email: "later@example.com" }, anna, NOW + 2 * DAY)).toMatchObject({
          ok: true,
        });
        expect(await listInvitations(db.runner, siteId, NOW + 2 * DAY)).toHaveLength(1);
      });

      test("cancelling stops the link at once; unknown ones and non-administrators are refused", async () => {
        const made = await invite();
        if (!made.ok) throw new Error(made.message);
        expect(
          await revokeInvitation(db.runner, actorOf(annaId, "editor"), siteId, made.invitation.id),
        ).toMatchObject({ ok: false, code: "forbidden" });
        expect(await revokeInvitation(db.runner, anna, siteId, "nope")).toMatchObject({
          ok: false,
          code: "not_found",
        });
        expect(await revokeInvitation(db.runner, anna, siteId, made.invitation.id)).toMatchObject({
          ok: true,
        });
        expect(await readInvitation(db.runner, siteId, made.token, NOW)).toBeNull();
        expect(await listInvitations(db.runner, siteId, NOW)).toEqual([]);
        expect(
          await acceptInvitation(
            db.runner,
            createAccount,
            siteId,
            made.token,
            { password: "a-long-password" },
            NOW,
          ),
        ).toMatchObject({ ok: false, code: "not_found" });
      });
    });

    describe("accepting an invitation", () => {
      test("makes the account and the membership with the invited role, and the link cannot be used again", async () => {
        const made = await invite();
        if (!made.ok) throw new Error(made.message);
        const accepted = await acceptInvitation(
          db.runner,
          createAccount,
          siteId,
          made.token,
          { name: "Eli Stone", password: "a-long-password" },
          NOW + 1000,
        );
        expect(accepted).toMatchObject({ ok: true, email: "eli@example.com", roleKey: "editor" });
        const members = await listMembers(db.runner, siteId);
        expect(members.find((m) => m.email === "eli@example.com")).toMatchObject({
          name: "Eli Stone",
          roleKey: "editor",
        });
        expect(await listInvitations(db.runner, siteId, NOW)).toEqual([]);
        // Used: it works no more.
        expect(
          await acceptInvitation(
            db.runner,
            createAccount,
            siteId,
            made.token,
            { password: "another-password" },
            NOW + 2000,
          ),
        ).toMatchObject({ ok: false, code: "not_found" });
        expect(await readInvitation(db.runner, siteId, made.token, NOW)).toBeNull();
      });

      test("the invited name is used when none is given", async () => {
        const made = await invite();
        if (!made.ok) throw new Error(made.message);
        await acceptInvitation(
          db.runner,
          createAccount,
          siteId,
          made.token,
          { password: "a-long-password" },
          NOW,
        );
        expect(
          (await listMembers(db.runner, siteId)).find((m) => m.email === "eli@example.com")!.name,
        ).toBe("Eli");
      });

      test("an expired link, a short password and a wrong link are refused, and nothing is created", async () => {
        const made = await invite({ days: 1 });
        if (!made.ok) throw new Error(made.message);
        expect(
          await acceptInvitation(
            db.runner,
            createAccount,
            siteId,
            made.token,
            { password: "a-long-password" },
            NOW + 2 * DAY,
          ),
        ).toMatchObject({ ok: false, code: "not_found" });
        expect(
          await acceptInvitation(
            db.runner,
            createAccount,
            siteId,
            made.token,
            { password: "short" },
            NOW,
          ),
        ).toMatchObject({ ok: false, code: "invalid", field: "password" });
        expect(PASSWORD_MIN).toBe(10);
        expect(
          await acceptInvitation(
            db.runner,
            createAccount,
            siteId,
            "wrong-link-wrong-link-wrong",
            { password: "a-long-password" },
            NOW,
          ),
        ).toMatchObject({ ok: false, code: "not_found" });
        expect(
          await acceptInvitation(
            db.runner,
            createAccount,
            siteId,
            "",
            { password: "a-long-password" },
            NOW,
          ),
        ).toMatchObject({ ok: false });
        expect(await listMembers(db.runner, siteId)).toHaveLength(1);
        // The short password did not use the invitation up.
        expect(await listInvitations(db.runner, siteId, NOW)).toHaveLength(1);
      });

      test("when the account is refused the invitation is put back and nothing is left over", async () => {
        const made = await invite();
        if (!made.ok) throw new Error(made.message);
        const refusing: CreateAccount = async () => {
          throw new Error("The password is too common.");
        };
        expect(
          await acceptInvitation(
            db.runner,
            refusing,
            siteId,
            made.token,
            { password: "a-long-password" },
            NOW,
          ),
        ).toMatchObject({ ok: false, message: "The password is too common." });
        expect(await listInvitations(db.runner, siteId, NOW)).toHaveLength(1);
        expect(await listMembers(db.runner, siteId)).toHaveLength(1);
        // And it can still be used.
        expect(
          await acceptInvitation(
            db.runner,
            createAccount,
            siteId,
            made.token,
            { password: "a-long-password" },
            NOW,
          ),
        ).toMatchObject({ ok: true });
      });

      test("if the role was removed in the meantime the new account is taken back out and the invitation is put back", async () => {
        const made = await invite({ roleKey: "contributor" });
        if (!made.ok) throw new Error(made.message);
        await db.run("update roles set key = 'renamed' where key = 'contributor'");
        const result = await acceptInvitation(
          db.runner,
          createAccount,
          siteId,
          made.token,
          { password: "a-long-password" },
          NOW,
        );
        expect(result).toMatchObject({ ok: false, code: "conflict" });
        expect(await db.run("select 1 from users where email = 'eli@example.com'")).toHaveLength(0);
        expect(await listInvitations(db.runner, siteId, NOW)).toHaveLength(1);
      });

      test("two people using the same link at once: one joins, the other is refused", async () => {
        const made = await invite();
        if (!made.ok) throw new Error(made.message);
        const results = await Promise.all(
          [1, 2, 3].map(() =>
            acceptInvitation(
              db.runner,
              createAccount,
              siteId,
              made.token,
              { password: "a-long-password" },
              NOW,
            ),
          ),
        );
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(await db.run("select 1 from users where email = 'eli@example.com'")).toHaveLength(1);
        expect(await listMembers(db.runner, siteId)).toHaveLength(2);
      });
    });
  });
}
