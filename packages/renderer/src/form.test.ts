// The form block (spec 16, section 3): real labels, every kind of field, text escaped, and a form that cannot send
// anywhere but to a plugin's own address of the site.
import { checkBlocks, type Block } from "@oks-page/content-safety";
import { describe, expect, test } from "vitest";
import { pageCss, writeBlocks } from "./index.js";

const form = (props: Record<string, unknown>): Block => ({
  id: "f1",
  type: "form",
  props: { action: "/api/oks/plugins/forms/send", ...props },
  content: null,
  children: [],
});
const html = (...blocks: Block[]) =>
  writeBlocks(checkBlocks({ version: 1, blocks } as never).body.blocks).html;

describe("the form block", () => {
  test("every kind of field has a real label; a required one is marked and announced", () => {
    const out = html(
      form({
        title: "Write <us>",
        fields: [
          {
            name: "name",
            label: "Your name",
            type: "text",
            required: true,
            help: "As on your card",
          },
          { name: "mail", label: "Email", type: "email" },
          { name: "phone", label: "Phone", type: "tel" },
          { name: "age", label: "Age", type: "number" },
          { name: "day", label: "Day", type: "date" },
          { name: "about", label: "About", type: "textarea" },
          { name: "topic", label: "Topic", type: "select", options: ["A", "B"] },
          { name: "kind", label: "Kind", type: "radio", required: true, options: ["One", "Two"] },
          { name: "tick", label: "Colours", type: "checkbox", options: ["Red", "Blue"] },
          { name: "ok", label: "I agree", type: "consent", required: true },
          { name: "src", label: "", type: "hidden", value: "home" },
        ],
      }),
    );
    expect(out).toContain('<h2 class="oks-form-title">Write &lt;us&gt;</h2>');
    expect(out).toContain(
      '<label for="f-f1-name">Your name<span aria-hidden="true"> *</span></label>',
    );
    expect(out).toContain('aria-describedby="f-f1-name-help"');
    expect(out).toContain('<p class="oks-form-help" id="f-f1-name-help">As on your card</p>');
    for (const type of ["email", "tel", "number", "date"]) expect(out).toContain(`type="${type}"`);
    expect(out).toContain('autocomplete="email"');
    expect(out).toContain('<textarea id="f-f1-about" name="about" rows="6">');
    expect(out).toContain('<option value="A">A</option>');
    expect(out).toContain("<legend>Kind");
    expect(out).toContain('<input type="radio" id="f-f1-kind-0" name="kind" value="One" required>');
    expect(out).toContain('<input type="checkbox" id="f-f1-tick-1" name="tick" value="Blue">');
    expect(out).toContain('<input type="hidden" name="src" value="home">');
    // the consent box is never ticked, and no box is
    expect(out).toContain('<input type="checkbox" id="f-f1-ok" name="ok" value="yes" required>');
    expect(out).not.toContain("checked");
    expect(out).toContain('method="post" action="/api/oks/plugins/forms/send"');
    expect(out).toContain('<button type="submit" class="button button-solid">Send</button>');
  });

  test("only a plugin's own address of this site is allowed as the action; fields with bad names or kinds are dropped", () => {
    const field = { name: "a", label: "A", type: "text" };
    for (const action of [
      "https://evil.example/x",
      "//evil.example/x",
      "/api/oks/other",
      "javascript:alert(1)",
      "/api/oks/plugins/forms/send?x=1",
      "",
    ])
      expect(html(form({ action, fields: [field] }))).toBe("");
    expect(html(form({ fields: [] }))).toBe("");
    const out = html(
      form({
        fields: [
          field,
          { name: "_hp", label: "Trap", type: "text" },
          { name: "Bad Name", label: "Bad", type: "text" },
          { name: "x", label: "X", type: "script" },
          { name: "a", label: "Again", type: "text" },
          { name: "pick", label: "Pick", type: "select", options: [] },
        ],
      }),
    );
    expect(out.match(/<label /g)?.length).toBe(2); // field "a" and the trap's own label
    expect(out).not.toContain("Bad Name");
  });

  test("the note may link to a safe address only, and the trap and signature are written", () => {
    const fields = [{ name: "a", label: "A", type: "text" }];
    expect(
      html(
        form({ fields, note: "Privacy", noteHref: "/privacy", token: "123.abc", formId: "abc" }),
      ),
    ).toContain('<p class="oks-form-note"><a href="/privacy">Privacy</a></p>');
    const unsafe = html(form({ fields, note: "Privacy", noteHref: "javascript:alert(1)" }));
    expect(unsafe).toContain('<p class="oks-form-note">Privacy</p>');
    expect(unsafe).not.toContain("javascript");
    const out = html(form({ fields, token: "123.abc", formId: "abc" }));
    expect(out).toContain('name="_hp" tabindex="-1" autocomplete="off"');
    expect(out).toContain('<input type="hidden" name="_t" value="123.abc">');
    expect(out).toContain('<input type="hidden" name="_form" value="abc">');
  });

  test("a page with a form, or with a plugin's block that may draw one, gets the form's rules", () => {
    const own = pageCss([form({ fields: [{ name: "a", label: "A", type: "text" }] })]);
    expect(own).toContain(".oks-form");
    const plugin = pageCss([
      { id: "p1", type: "forms-form", props: {}, content: null, children: [] } as Block,
    ]);
    expect(plugin).toContain(".oks-form");
    expect(pageCss([])).not.toContain(".oks-form");
  });
});

describe("a form that asks for files", () => {
  const fields = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "cv", label: "Your CV", type: "file", required: true, help: "Up to 3 files." },
  ];

  test("is sent in parts, and the file question has a real label, takes several files and says which kinds", () => {
    const out = html(form({ fields }));
    expect(out).toContain('enctype="multipart/form-data"');
    expect(out).toMatch(
      /<label for="[^"]*-cv">Your CV<span aria-hidden="true"> \*<\/span><\/label>/,
    );
    const input = /<input type="file"[^>]*>/.exec(out)?.[0] ?? "";
    expect(input).toContain('name="cv"');
    expect(input).toContain("multiple");
    expect(input).toContain("application/pdf");
    expect(input).toContain("image/png");
    expect(input).not.toContain("svg");
    expect(input).toContain("required");
    expect(input).toContain("aria-describedby");
    expect(out).toContain("Up to 3 files.");
  });

  test("a form without a file question stays a plain form", () => {
    const out = html(form({ fields: [fields[0]!] }));
    expect(out).toContain('enctype="application/x-www-form-urlencoded"');
    expect(out).not.toContain('type="file"');
  });
});
