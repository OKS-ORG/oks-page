// The Forms plugin (spec 16): packed with `oks pack`, run in the real sandbox on SQLite and PostgreSQL. The form is drawn
// by the plugin's block, checked and written by the core, and what a visitor sends goes through the plugin's address.
import { packPlugin } from "../../../packages/cli/src/pack.js";
import { checkBlocks } from "@oks-page/content-safety";
import { writeBlocks } from "@oks-page/renderer";
import { openers, type TestDb } from "@oks-page/db/testing";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  SandboxHost,
  readPluginFile,
  type PluginFile,
  type RouteReply,
} from "../../../packages/sandbox/src/index.js";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000070";
const EXT = "EXT00000000000000000000070";
const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Drawn {
  formId: string;
  token: string;
  fields: { name: string }[];
  html: string;
}

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the Forms plugin`, () => {
    let db: TestDb;
    let host: SandboxHost;
    let file: PluginFile;
    const workDir = mkdtempSync(join(tmpdir(), "oks-forms-"));
    const settings: Record<string, unknown> = { send_to: "owner@example.com" };
    const mails: { to: string; subject: string; text: string }[] = [];
    const forms: Record<string, Drawn> = {};

    const draw = async (props: Record<string, unknown>): Promise<Drawn> => {
      const r = await host.call("forms", "block", "form", props);
      expect(r.ok).toBe(true);
      const block = (r as { result: { props: Drawn } }).result;
      const checked = checkBlocks({ version: 1, blocks: [block] } as never);
      return {
        formId: block.props.formId,
        token: block.props.token,
        fields: block.props.fields,
        html: writeBlocks(checked.body.blocks).html,
      };
    };

    const send = async (
      form: Drawn,
      values: Record<string, string | string[]>,
      over: Record<string, string> = {},
    ): Promise<RouteReply | { status: number; message: string }> => {
      const body = new URLSearchParams({ _form: form.formId, _t: form.token, _hp: "", ...over });
      for (const [k, v] of Object.entries(values))
        for (const one of Array.isArray(v) ? v : [v]) body.append(k, one);
      const r = await host.runRoute("forms", "send", {
        method: "POST",
        query: {},
        body: body.toString(),
        data: null,
        contentType: "application/x-www-form-urlencoded",
      });
      return r.ok ? r.reply : r;
    };

    const stored = async (): Promise<
      {
        status: string;
        why?: string;
        title: string;
        at: number;
        summary: string;
        values: { label: string; value: string }[];
      }[]
    > => {
      const rows = await db.runner.all(
        "select value from extension_storage where extension_id = ? and collection = 'messages' order by key",
        [EXT],
      );
      return rows.map((r) =>
        typeof r["value"] === "string" ? JSON.parse(r["value"]) : r["value"],
      );
    };

    beforeAll(async () => {
      const packed = await packPlugin(PLUGIN_DIR, join(workDir, "forms.oksplugin"));
      expect(packed.report).not.toContain("FAIL");
      expect(packed.ok).toBe(true);
      const read = readPluginFile(readFileSync(join(workDir, "forms.oksplugin"), "utf8"));
      if (!read.ok) throw new Error(read.message);
      file = read.file;
      db = await open();
      await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
        SITE,
        T,
        T,
      ]);
      await db.run(
        "insert into extensions (id, site_id, key, kind, version, tier, installed_at) values (?, ?, 'forms', 'plugin', '1.0.0', 'runtime', ?)",
        [EXT, SITE, T],
      );
      host = new SandboxHost({
        runner: db.runner,
        siteId: SITE,
        content: { get: async () => null, update: async () => null },
        settings: async (_plugin, key) => settings[key],
        sendEmail: async (_plugin, mail) => {
          mails.push(mail);
          return { sent: true };
        },
        workDir,
        // Generous, so a busy machine running the whole suite does not turn a slow first start into a failure.
        wallMs: 30000,
        publishWallMs: 30000,
        maxFailures: 100,
        onDeveloperNote: () => undefined,
      });
      await host.listen();
      host.load(
        {
          id: "forms",
          version: file.manifest.version,
          permissions: file.manifest.permissions,
          routes: file.manifest.routes as never,
          jobs: file.manifest.jobs as never,
        },
        file.code,
        EXT,
      );
      forms["contact"] = await draw({
        title: "Contact us",
        fields:
          "Name*; Email*:email; Topic:choice(Sales|Support); Colours:ticks(Red|Blue); Message*:long; Newsletter:consent",
        thanks: "We will write back soon.",
      });
      forms["confirm"] = await draw({
        title: "Callback",
        fields: "Name*; Email*:email",
        confirm: true,
        confirm_text: "Thanks, we got it.",
        send_to: "sales@example.com, boss@example.com",
      });
      forms["goto"] = await draw({
        fields: "Name*",
        thanks_page: "/thank-you",
      });
      forms["rate"] = await draw({ title: "Busy", fields: "Name*" });
      // A form cannot be sent faster than a person can: the signed time must be old enough.
      await sleep(3500);
    }, 60_000);

    afterAll(async () => {
      await host?.close();
      await db?.close();
      rmSync(workDir, { recursive: true, force: true });
    });

    test("the plugin passes the check and asks only for email and public addresses", () => {
      expect(file.manifest.permissions.sort()).toEqual([
        "admin:pages",
        "email:send",
        "routes:public",
      ]);
      // The Messages page is data: a table over the plugin's own storage.
      expect(file.manifest.adminPages?.[0]).toMatchObject({
        id: "messages",
        view: { source: "storage:messages", export: true },
      });
      expect(Object.keys(file.manifest.routes ?? {})).toEqual(["send"]);
      expect(file.manifest.blocks).toEqual(["form"]);
    });

    test("every field is drawn with a real label, required marks and a hidden trap; nothing is ticked in advance", () => {
      const html = forms["contact"]!.html;
      expect(html).toContain(
        '<form class="oks-form" method="post" action="/api/oks/plugins/forms/send"',
      );
      expect(html).toMatch(
        /<label for="[^"]*-name">Name<span aria-hidden="true"> \*<\/span><\/label>/,
      );
      expect(html).toMatch(/name="name"[^>]*required aria-required="true"/);
      expect(html).toContain('type="email"');
      expect(html).toContain('autocomplete="email"');
      expect(html).toContain("<legend>Topic</legend>");
      expect(html).toContain('type="radio"');
      expect(html).toContain('type="checkbox"');
      expect(html).toContain("<textarea");
      expect(html).toContain('name="_hp"');
      expect(html).toContain('name="_t"');
      expect(html).toContain('name="_form"');
      expect(html).toContain("<h2");
      // FM-09: the consent box (and every box) is unticked.
      expect(html).not.toContain("checked");
      // A form that asks for an email has no outside address in it.
      expect(html).not.toMatch(/https?:\/\//);
    });

    test("a form that sends to an address outside the plugin's own is not drawn", () => {
      const out = checkBlocks({
        version: 1,
        blocks: [
          {
            id: "a",
            type: "form",
            props: {
              action: "https://evil.example/steal",
              fields: [{ name: "x", label: "X", type: "text" }],
            },
            content: null,
            children: [],
          },
          {
            id: "b",
            type: "form",
            props: {
              action: "/api/oks/plugins/forms/send",
              fields: [{ name: "_t", label: "X", type: "text" }],
            },
            content: null,
            children: [],
          },
        ],
      } as never);
      expect(writeBlocks(out.body.blocks).html).toBe("");
    });

    test("a sent form is kept and emailed to the owner; the visitor sees the thank-you page", async () => {
      const before = mails.length;
      const r = await send(forms["contact"]!, {
        name: "Anna <b>Berg</b>",
        email: "anna@example.com",
        topic: "Support",
        colours: ["Red", "Blue"],
        message: "Hello there",
        newsletter: "yes",
      });
      expect(r).toEqual({
        status: 200,
        page: { title: "Thank you", text: "We will write back soon." },
      });
      const messages = await stored();
      const last = messages[messages.length - 1]!;
      expect(last.status).toBe("new");
      expect(last.title).toBe("Contact us");
      expect(last.values).toContainEqual({ label: "Name", value: "Anna <b>Berg</b>" });
      expect(last.values).toContainEqual({ label: "Colours", value: "Red, Blue" });
      // One line for the Messages page, every answer with its label.
      expect(last.summary).toContain("Name: Anna <b>Berg</b> · Email: anna@example.com");
      expect(last.values).toContainEqual({ label: "Newsletter", value: "yes" });
      expect(mails.length).toBe(before + 1);
      expect(mails[before]).toMatchObject({
        to: "owner@example.com",
        subject: "New message: Contact us",
      });
      expect(mails[before]!.text).toContain("Email: anna@example.com");
    });

    test("the confirmation to the sender goes only when it is switched on, and the owner addresses of the form are used", async () => {
      const before = mails.length;
      await send(forms["confirm"]!, { name: "Bo", email: "bo@example.com" });
      const sent = mails.slice(before).map((m) => m.to);
      expect(sent).toEqual(["sales@example.com", "boss@example.com", "bo@example.com"]);
      expect(mails[before + 2]).toMatchObject({
        subject: "We got your message",
        text: "Thanks, we got it.",
      });
      // FM-05: the contact form has no confirmation switched on.
      const again = mails.length;
      await send(forms["contact"]!, { name: "Cy", email: "cy@example.com", message: "Hi" });
      expect(mails.slice(again).map((m) => m.to)).toEqual(["owner@example.com"]);
    });

    test("a form can send people to another page instead", async () => {
      expect(await send(forms["goto"]!, { name: "Di" })).toEqual({
        status: 303,
        redirect: "/thank-you",
      });
    });

    test("wrong answers get a plain page that names each problem, and nothing is kept", async () => {
      const before = (await stored()).length;
      const r = (await send(forms["contact"]!, {
        name: "",
        email: "not-an-email",
        topic: "Other",
        message: "x".repeat(5001),
      })) as { status: number; page: { title: string; text: string } };
      expect(r.status).toBe(400);
      expect(r.page.title).toBe("Please check your answers");
      expect(r.page.text).toContain("Name: this is required.");
      expect(r.page.text).toContain("Email: this is not an email address.");
      expect(r.page.text).toContain("Topic: this is not one of the choices.");
      expect(r.page.text).toContain("Message: this is too long.");
      expect((await stored()).length).toBe(before);
    });

    test("spam goes to Spam with no email and the visitor is told nothing", async () => {
      const thanks = {
        status: 200,
        page: { title: "Thank you", text: "We will write back soon." },
      };
      const ok = { name: "Eve", email: "eve@example.com", message: "Hello" };
      const mailsBefore = mails.length;
      const keptBefore = (await stored()).length;
      // the hidden field
      expect(await send(forms["contact"]!, ok, { _hp: "http://spam.example" })).toEqual(thanks);
      // a made-up signature
      expect(
        await send(forms["contact"]!, ok, { _t: `${Date.now() - 60_000}.${"0".repeat(32)}` }),
      ).toEqual(thanks);
      // no signature at all
      expect(await send(forms["contact"]!, ok, { _t: "" })).toEqual(thanks);
      // too many links
      expect(
        await send(forms["contact"]!, {
          ...ok,
          message: "see http://a.example http://b.example http://c.example",
        }),
      ).toEqual(thanks);
      // a word on the list, and a word the owner added
      expect(await send(forms["contact"]!, { ...ok, message: "cheap CASINO" })).toEqual(thanks);
      settings["blocked_words"] = "bitcoin, seo";
      expect(await send(forms["contact"]!, { ...ok, message: "Buy BitCoin" })).toEqual(thanks);
      // sent faster than a person can
      const quick = await draw({ title: "Quick", fields: "Name*" });
      expect(await send(quick, { name: "Fast" })).toMatchObject({ status: 200 });
      const messages = await stored();
      const spam = messages.slice(keptBefore);
      expect(spam.map((m) => m.status)).toEqual([
        "spam",
        "spam",
        "spam",
        "spam",
        "spam",
        "spam",
        "spam",
      ]);
      expect(spam[0]!.why).toBe("the hidden field was filled in");
      expect(spam[6]!.why).toBe("it was sent faster than a person can");
      expect(mails.length).toBe(mailsBefore);
    });

    test("a form that is not known, or a page drawn long ago, is refused politely", async () => {
      const unknown = { ...forms["contact"]!, formId: "0123456789abcdef" };
      expect(await send(unknown, { name: "x" })).toMatchObject({
        status: 404,
        page: { title: "This form is not available" },
      });
      const text = await host.runRoute("forms", "send", {
        method: "POST",
        query: {},
        body: "name=x",
        data: null,
        contentType: "application/x-www-form-urlencoded",
      });
      expect(text.ok && text.reply.status).toBe(404);
    });

    test("messages older than the keeping time are deleted, oldest first", async () => {
      const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
      await db.run(
        "insert into extension_storage (extension_id, collection, key, value, size_bytes, updated_at) values (?, 'messages', ?, ?, 10, ?)",
        [
          EXT,
          `${String(old).padStart(15, "0")}-aaaaaa`,
          JSON.stringify({ at: old, status: "new", title: "Old", values: [] }),
          T,
        ],
      );
      expect((await stored()).some((m) => m.title === "Old")).toBe(true);
      await send(forms["contact"]!, { name: "Fay", email: "fay@example.com", message: "Hi again" });
      expect((await stored()).some((m) => m.title === "Old")).toBe(false);
      // The owner may keep them for a shorter time.
      settings["keep_months"] = 1;
      const middle = Date.now() - 60 * 24 * 60 * 60 * 1000;
      await db.run(
        "insert into extension_storage (extension_id, collection, key, value, size_bytes, updated_at) values (?, 'messages', ?, ?, 10, ?)",
        [
          EXT,
          `${String(middle).padStart(15, "0")}-bbbbbb`,
          JSON.stringify({ at: middle, status: "new", title: "Middle", values: [] }),
          T,
        ],
      );
      await send(forms["contact"]!, { name: "Gus", email: "gus@example.com", message: "Hi" });
      expect((await stored()).some((m) => m.title === "Middle")).toBe(false);
      delete settings["keep_months"];
    });

    test("the keeping job deletes the messages that are past their time on its own, without a new message", async () => {
      expect(file.manifest.jobs).toEqual({ keep: { everyMinutes: 1440 } });
      const day = 24 * 60 * 60 * 1000;
      const insert = (at: number, tag: string, title: string) =>
        db.run(
          "insert into extension_storage (extension_id, collection, key, value, size_bytes, updated_at) values (?, 'messages', ?, ?, 10, ?)",
          [
            EXT,
            `${String(at).padStart(15, "0")}-${tag}`,
            JSON.stringify({ at, status: "new", title, values: [] }),
            T,
          ],
        );
      // 120 old messages (more than one round of 50) and one that is recent.
      for (let i = 0; i < 120; i += 1) await insert(Date.now() - 500 * day + i, `o${i}`, "Ancient");
      await insert(Date.now() - day, "recent", "Recent");
      expect((await stored()).filter((m) => m.title === "Ancient").length).toBe(120);
      const run = await host.runJob("forms", "keep");
      expect(run).toEqual({ ok: true });
      const after = await stored();
      expect(after.filter((m) => m.title === "Ancient").length).toBe(0);
      expect(after.some((m) => m.title === "Recent")).toBe(true);
      // A job the plugin did not list cannot be run.
      expect((await host.runJob("forms", "nothing")).ok).toBe(false);
    });

    test("one form takes at most 30 messages an hour; the rest are dropped without telling the sender", async () => {
      const results = [];
      for (let i = 0; i < 33; i++) results.push(await send(forms["rate"]!, { name: `N${i}` }));
      expect(results.every((r) => (r as { status: number }).status === 200)).toBe(true);
      const busy = (await stored()).filter((m) => m.title === "Busy");
      expect(busy.length).toBe(30);
    }, 60_000);
  });
}
