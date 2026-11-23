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
  type RouteFile,
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
      files: RouteFile[] = [],
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
        ...(files.length > 0 ? { files } : {}),
      });
      return r.ok ? r.reply : r;
    };

    /** A file the site received for this plugin and is waiting to be attached (the site made the row, as it does for a visitor). */
    const received = async (n: number, name: string, field = "your_cv"): Promise<RouteFile> => {
      const id = `FILE${String(n).padStart(22, "0")}`;
      await db.run(
        `insert into extension_files (id, extension_id, name, mime, size_bytes, sha256, status, data, created_at) values (?, ?, ?, 'application/pdf', 5, 'x', 'pending', ?, ?)`,
        [id, EXT, name, Buffer.from([1, 2, 3, 4, 5]), T],
      );
      return { field, id, name, type: "application/pdf", size: 5 };
    };
    const fileRows = async () =>
      (
        await db.runner.all(
          `select "id", "status", "collection" from extension_files where extension_id = ? order by "id"`,
          [EXT],
        )
      ).map((r) => [String(r["id"]).replace(/^FILE0*/, ""), String(r["status"]), r["collection"]]);

    const stored = async (): Promise<
      {
        status: string;
        why?: string;
        title: string;
        at: number;
        summary: string;
        emails?: string[];
        files?: { id: string; name: string; type: string; size: number }[];
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

    test("the plugin file kept in the product package is what oks pack makes from this source", () => {
      // New sites install that file (spec 16): it must not drift from the plugin that is tested here.
      const kept = JSON.parse(
        readFileSync(
          new URL("../../../packages/oks-page/src/forms-plugin-file.json", import.meta.url),
          "utf8",
        ),
      );
      // Both read back the way a site reads a plugin file (the pages are normalised there).
      const keptRead = readPluginFile(JSON.stringify(kept));
      expect(keptRead.ok && keptRead.file).toEqual(file);
      expect(kept.code).toBe(file.code);
      expect(kept.integrity).toBe(file.integrity);
    });

    test("the plugin passes the check and asks only for email and public addresses", () => {
      expect(file.manifest.permissions.sort()).toEqual([
        "admin:pages",
        "email:send",
        "files:private",
        "routes:public",
      ]);
      // The messages are declared as personal data, found by their email addresses.
      expect(file.manifest.personalData?.[0]).toMatchObject({
        id: "form-messages",
        source: "storage:messages",
        match: ["emails"],
      });
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

    test("the page builder's list of fields makes the same form as the line of text, and a form written either way is sent", async () => {
      const list = [
        { label: "Name", kind: "text", required: true, options: "" },
        { label: "Email", kind: "email", required: true, options: "" },
        { label: "Topic", kind: "select", required: false, options: "Sales|Support" },
        { label: "Colours", kind: "ticks", required: false, options: "Red|Blue" },
        { label: "Agree", kind: "consent", required: false, options: "" },
      ];
      const fromList = await draw({ title: "Same", fields: list });
      const fromText = await draw({
        title: "Same",
        fields:
          "Name*; Email*:email; Topic:select(Sales|Support); Colours:ticks(Red|Blue); Agree:consent",
      });
      // The same definition is the same form: one identity, the same drawing.
      expect(fromList.formId).toBe(fromText.formId);
      // (Each drawing carries its own signed time, which is the only thing that may differ.)
      const withoutTime = (html: string) => html.replace(/(name="_t" value=")[^"]*/, "$1");
      expect(withoutTime(fromList.html)).toBe(withoutTime(fromText.html));
      expect(fromList.html).toContain('<option value="Support">');
      const r = await send(fromList, { name: "Lia", email: "lia@example.com", agree: "yes" });
      expect((r as { status: number }).status).toBe(200);
      expect((await stored()).some((m) => m.summary.includes("Name: Lia"))).toBe(true);
    });

    test("the ready-made forms are Contact, Ask for an offer, Call me back and Newsletter sign-up, and each makes a whole form", async () => {
      const presets = file.manifest.blockInfo?.["form"]?.presets ?? [];
      expect(presets.map((p) => p.label)).toEqual([
        "Contact form",
        "Ask for an offer",
        "Call me back",
        "Newsletter sign-up",
      ]);
      const ids = new Set<string>();
      for (const preset of presets) {
        const rows = preset.settings["fields"] as { label: string }[];
        const drawn = await draw(preset.settings);
        // Every row of the ready-made list is a field of the form (none was left out), under a form of its own.
        expect(drawn.fields.map((f) => (f as { label?: string }).label)).toEqual(
          rows.map((r) => r.label),
        );
        ids.add(drawn.formId);
        expect(drawn.html).toContain(`>${String(preset.settings["button"])}</button>`);
      }
      expect(ids.size).toBe(4);
      // The sign-up asks for agreement to get news, and it is never ticked in advance (FM-09).
      const signup = await draw(presets[3]!.settings);
      expect(signup.html).toMatch(/type="checkbox"[^>]*required/);
      expect(signup.html).not.toMatch(/type="checkbox"[^>]*checked/);
    });

    test("a file question is drawn with its help, there is only one per form, and the key stays a kind of the list", async () => {
      const d = await draw({
        fields: [
          { label: "Name", kind: "text", required: true },
          { label: "Your CV", kind: "file", required: false },
          { label: "Another file", kind: "file" },
        ],
      });
      const fields = d.fields as {
        label: string;
        type: string;
        help?: string;
        required: boolean;
      }[];
      expect(fields.map((f) => [f.label, f.type])).toEqual([
        ["Name", "text"],
        ["Your CV", "file"],
      ]);
      expect(fields[1]!.help).toBe("Up to 3 pictures or PDF files, 10 MB each.");
      expect(d.html).toContain('enctype="multipart/form-data"');
      expect(d.html).toMatch(/<input type="file"[^>]*name="your_cv"[^>]*multiple/);
      // The line of text knows the same kind.
      const line = await draw({ fields: "Name*; Your CV:file" });
      expect((line.fields as { type: string }[]).map((f) => f.type)).toEqual(["text", "file"]);
    });

    test("files that came with a message are attached to it, listed in the message and the email, and go with it", async () => {
      const form = await draw({ title: "Apply", fields: "Name*; Your CV*:file" });
      await sleep(3200); // a form sent faster than a person can is kept apart as spam
      const cv = await received(1, "cv-anna.pdf");
      const extra = await received(2, "letter.pdf");
      const before = mails.length;
      const r = await send(form, { name: "Anna" }, {}, [cv, extra]);
      expect((r as { status: number }).status).toBe(200);
      const last = (await stored()).at(-1)!;
      expect(last.files?.map((f) => f.name)).toEqual(["cv-anna.pdf", "letter.pdf"]);
      expect(last.summary).toBe("Name: Anna · Your CV: cv-anna.pdf, letter.pdf");
      expect(mails.length).toBe(before + 1);
      expect(mails[before]!.text).toContain("The files are kept privately");
      expect(mails[before]!.text).toContain("Your CV: cv-anna.pdf, letter.pdf");
      // Attached, with the message's own key.
      const key = String(
        (
          await db.runner.all(
            `select "key" from extension_storage where extension_id = ? and collection = 'messages' order by "key" desc limit 1`,
            [EXT],
          )
        )[0]!["key"],
      );
      const rows = await db.runner.all(
        `select "id", "status", "collection", "key" from extension_files where extension_id = ? order by "id"`,
        [EXT],
      );
      expect(
        rows.map((x) => [String(x["status"]), String(x["collection"]), String(x["key"])]),
      ).toEqual([
        ["kept", "messages", key],
        ["kept", "messages", key],
      ]);
      // The keeping job deletes an old message, and the files go with it.
      await db.run(
        `update extension_storage set key = ? where extension_id = ? and collection = 'messages' and key = ?`,
        ["000000000000001-old", EXT, key],
      );
      await db.run(
        `update extension_files set key = '000000000000001-old' where extension_id = ?`,
        [EXT],
      );
      await db.run(
        `update extension_storage set value = ? where extension_id = ? and key = '000000000000001-old'`,
        [JSON.stringify({ ...last, at: Date.now() - 500 * 24 * 60 * 60 * 1000 }), EXT],
      );
      expect(await host.runJob("forms", "keep")).toEqual({ ok: true });
      expect(await fileRows()).toEqual([]);
    });

    test("a required file that did not come, and files of another question, are handled", async () => {
      const form = await draw({ fields: "Name*; Your CV*:file" });
      await sleep(3200);
      const before = (await stored()).length;
      const none = await send(form, { name: "Ben" });
      expect((none as { status: number }).status).toBe(400);
      expect(JSON.stringify(none)).toContain("Your CV: choose a file.");
      // A file that came in a field the form does not have is not attached.
      const stray = await received(3, "stray.pdf", "somewhere_else");
      const again = await send(form, { name: "Ben" }, {}, [stray]);
      expect((again as { status: number }).status).toBe(400);
      expect((await stored()).length).toBe(before);
      expect((await fileRows()).filter((x) => x[0] === "3")).toEqual([["3", "pending", null]]);
    });

    test("a message kept apart as spam keeps no files: they stay unattached and go with the hour", async () => {
      const form = await draw({ fields: "Name*; Your CV:file" });
      const cv = await received(4, "spam.pdf");
      const r = await send(form, { name: "Bot" }, { _hp: "x" }, [cv]);
      expect((r as { status: number }).status).toBe(200);
      const last = (await stored()).at(-1)!;
      expect(last.status).toBe("spam");
      expect(last.files).toBeUndefined();
      expect((await fileRows()).find((x) => x[0] === "4")).toEqual(["4", "pending", null]);
    });

    test("rows of the list that make no sense are left out, and a list with nothing usable falls back to the standard form", async () => {
      const mixed = await draw({
        fields: [
          { label: "Fine", kind: "text", required: true },
          { label: "", kind: "text" },
          { label: "No choices", kind: "select", options: "" },
          { label: "Odd kind", kind: "script" },
          "not a row",
          null,
          { label: "Pick", kind: "radio", options: "A|B" },
        ],
      });
      expect(mixed.fields.map((f) => (f as { label?: string }).label)).toEqual(["Fine", "Pick"]);
      const standard = await draw({ fields: "Name*; Email*:email; Message*:long" });
      for (const fields of [[], [{ label: "", kind: "text" }], "", "   ", undefined, 7]) {
        const d = await draw({ fields });
        expect(d.formId).toBe(standard.formId);
      }
      // At most 30 fields, as with the line of text.
      const many = await draw({
        fields: Array.from({ length: 45 }, (_, i) => ({ label: `Question ${i}`, kind: "text" })),
      });
      expect(many.fields.length).toBe(30);
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
      // The address is kept in one plain form, in a field of its own, so a privacy request can find the message (spec 18).
      expect(last.emails).toEqual(["anna@example.com"]);
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
