import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import {
  EMAIL_JOB,
  emailJobHandler,
  saveEmailSettings,
  type MakeTransport,
  type OutgoingEmail,
} from "./email.js";
import {
  EMAIL_TEXTS,
  emailTextProblems,
  listEmailTexts,
  previewEmailText,
  renderEmailText,
  renderSubject,
  resetEmailText,
  saveEmailText,
} from "./email-texts.js";
import { sendInvitationEmail, sendPasswordResetEmail } from "./emails.js";
import { drainJobs } from "./jobs.js";
import { DEFAULT_ROLES } from "./roles.js";
import { SiteSecrets } from "./secret-box.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

describe("the words of an email (spec 13, section 6)", () => {
  test("every original text passes its own checks", () => {
    for (const t of EMAIL_TEXTS)
      expect(emailTextProblems(t.key, t.subject, t.body), t.key).toEqual([]);
  });

  test("a text without a required placeholder, with an unknown one, or with a link that is not https is refused (EM-10)", () => {
    expect(emailTextProblems("password-reset", "Reset", "Hello {name}, here is help.")).toEqual([
      "The text must contain {link}: without it the email cannot do its job.",
    ]);
    expect(emailTextProblems("password-reset", "Reset", "{link} {password}").join(" ")).toContain(
      "{password} is not a placeholder of this email.",
    );
    expect(
      emailTextProblems("invitation", "Hi", "{link} [Our rules](http://example.com/rules)").join(
        " ",
      ),
    ).toContain('The link "Our rules" must start with https://');
    expect(
      emailTextProblems("invitation", "Hi", "{link} [Bad](javascript:alert(1))").join(" "),
    ).toContain("must start with https://");
    expect(emailTextProblems("invitation", "", "{link}")).toContain("The subject cannot be empty.");
    expect(emailTextProblems("invitation", "Two\nlines", "{link}")).toContain(
      "The subject must be one line.",
    );
    expect(emailTextProblems("nothing", "x", "y")).toEqual(["There is no such email."]);
    // The footer may be empty.
    expect(emailTextProblems("footer", "", "")).toEqual([]);
  });

  test("values are always escaped; bold, italic, lists and links; the main link is a button and a plain address too", () => {
    const mail = renderEmailText(
      "Hello {name},\n\n**Welcome** to *{site}*.\n\n- one\n- two\n\n[Start here]({link})\n\n[Our rules](https://example.com/rules)",
      "{site}\nSome street 1",
      {
        name: '<script>alert("x")</script>',
        site: "Anna's <Garden>",
        link: "https://example.com/admin/invite/abc?x=1&y=2",
      },
    );
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("Hello &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;,");
    expect(mail.html).toContain("<strong>Welcome</strong> to <em>Anna&#39;s &lt;Garden&gt;</em>.");
    expect(mail.html).toContain("<li>one</li><li>two</li>");
    expect(mail.html).toContain('href="https://example.com/admin/invite/abc?x=1&amp;y=2"');
    expect(mail.html).toContain(
      "If the button does not work, copy this address into your browser:",
    );
    expect(mail.html).toContain('<a href="https://example.com/rules">Our rules</a>');
    expect(mail.html).toContain("Some street 1");
    expect(mail.html).not.toMatch(/<img|src=/);
    expect(mail.text).toContain('Hello <script>alert("x")</script>,');
    expect(mail.text).toContain("Welcome to Anna's <Garden>.");
    expect(mail.text).toContain("Start here: https://example.com/admin/invite/abc?x=1&y=2");
    expect(mail.text.endsWith("Anna's <Garden>\nSome street 1")).toBe(true);
    // A value that is not a web address never becomes a link.
    expect(
      renderEmailText("[Open]({link})", "", { link: "javascript:alert(1)" }).html,
    ).not.toContain("href=");
    expect(renderSubject("Hi {name}", { name: "Ben\nBcc: x@example.com" })).toBe(
      "Hi Ben Bcc: x@example.com",
    );
  });

  test("the preview uses the sample values; the footer is previewed under an invitation", () => {
    const def = EMAIL_TEXTS.find((t) => t.key === "invitation")!;
    const preview = previewEmailText(
      "invitation",
      def.subject,
      def.body,
      "{site}",
      "Anna's Garden",
    );
    expect(preview.subject).toBe("You are invited to Anna's Garden");
    expect(preview.text).toContain("Anna invites you to work on Anna's Garden as Editor.");
    expect(preview.problems).toEqual([]);
    const footer = previewEmailText("footer", "", "{site}, Some street 1", "", "Anna's Garden");
    expect(footer.text.endsWith("Anna's Garden, Some street 1")).toBe(true);
    expect(previewEmailText("password-reset", "x", "no link", "", "S").problems).toHaveLength(1);
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the owner's email texts`, () => {
    let db: TestDb;
    let siteId = "";
    let admin: Actor;
    let editor: Actor;
    const secrets = new SiteSecrets("x".repeat(40));
    let sent: OutgoingEmail[];
    const accepting: MakeTransport = () => ({
      send: async (email) => {
        sent.push(email);
      },
    });
    const send = () =>
      drainJobs(db.runner, {
        [EMAIL_JOB]: emailJobHandler(db.runner, secrets, { makeTransport: accepting }),
      });

    beforeEach(async () => {
      sent = [];
      db = await open();
      const setup = await runSetup(
        db.runner,
        async ({ name, email }) => {
          const userId = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [userId, name, email, T, T],
          );
          return { userId };
        },
        {
          siteName: "Anna's Garden",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      admin = actorOf(setup.userId, "administrator");
      editor = actorOf(setup.userId, "editor");
      await saveEmailSettings(
        db.runner,
        admin,
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
      sent = [];
    });
    afterEach(async () => db.close());

    const reset = () =>
      sendPasswordResetEmail(db.runner, siteId, secrets, {
        to: "ben@example.com",
        name: "Ben",
        siteName: "Anna's Garden",
        link: "https://garden.example/admin/reset-password?token=t1",
      });

    test("an edited text is used; reset brings the original back; security edits are in the audit log (EM-10, EM-11)", async () => {
      expect(
        await saveEmailText(db.runner, editor, siteId, "password-reset", {
          subject: "x",
          body: "{link}",
        }),
      ).toMatchObject({ code: "forbidden" });
      expect(
        await saveEmailText(db.runner, admin, siteId, "password-reset", {
          subject: "New password",
          body: "Hi {name}",
        }),
      ).toMatchObject({ ok: false, message: expect.stringContaining("must contain {link}") });
      expect(
        await saveEmailText(db.runner, admin, siteId, "password-reset", {
          subject: "A new password for {site}",
          body: "Dear {name},\n\n**Here is your link:** [set it]({link})",
        }),
      ).toEqual({ ok: true });
      await saveEmailText(db.runner, admin, siteId, "footer", {
        subject: "",
        body: "{site}, Garden Lane 4",
      });
      const list = await listEmailTexts(db.runner, admin, siteId);
      expect(
        list.ok &&
          list.texts
            .filter((t) => t.edited)
            .map((t) => t.key)
            .sort(),
      ).toEqual(["footer", "password-reset"]);
      await reset();
      await send();
      expect(sent[0]!.subject).toBe("A new password for Anna's Garden");
      expect(sent[0]!.text).toBe(
        "Dear Ben,\n\nHere is your link: set it: https://garden.example/admin/reset-password?token=t1\n\nAnna's Garden, Garden Lane 4",
      );
      expect(sent[0]!.html).toContain("<strong>Here is your link:</strong>");
      // Only the security email is audited.
      const audited = await db.run(
        "select action, target_id from audit_log where target_type = 'email_text'",
      );
      expect(audited).toEqual([{ action: "email_text.change", target_id: "password-reset" }]);

      expect(await resetEmailText(db.runner, admin, siteId, "password-reset")).toEqual({
        ok: true,
      });
      sent = [];
      await reset();
      await send();
      expect(sent[0]!.subject).toBe("Choose a new password for Anna's Garden");
      expect(
        (
          await db.run(
            "select action from audit_log where target_type = 'email_text' order by created_at",
          )
        ).map((r) => r["action"]),
      ).toEqual(["email_text.change", "email_text.reset"]);
    });

    test("a stored text that no longer passes the checks is not used: the original goes out", async () => {
      await db.run(
        `insert into email_texts (site_id, email_key, locale, subject, body, updated_by, updated_at) values (?, 'invitation', '', 'Join', 'No link here', null, ?)`,
        [siteId, T],
      );
      await sendInvitationEmail(db.runner, siteId, secrets, {
        to: "ben@example.com",
        name: "Ben",
        inviter: "Anna",
        siteName: "Anna's Garden",
        role: "Editor",
        link: "https://garden.example/admin/invite/abc",
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      await send();
      expect(sent[0]!.subject).toBe("You are invited to Anna's Garden");
      expect(sent[0]!.text).toContain(
        "Accept the invitation: https://garden.example/admin/invite/abc",
      );
    });
  });
}
