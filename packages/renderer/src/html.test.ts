// The HTML writer: every block type, the escaping, and the hostile documents (EC-33).
import { checkBlocks, type Block } from "@oks-page/content-safety";
import { describe, expect, test } from "vitest";
import { escapeHtml, writeBlocks } from "./html.js";

let n = 0;
const block = (type: string, over: Partial<Block> = {}): Block => ({
  id: `b${++n}`,
  type,
  props: {},
  content: null,
  children: [],
  ...over,
});
const text = (value: string, styles?: Record<string, unknown>) => ({
  type: "text",
  text: value,
  ...(styles ? { styles } : {}),
});
const para = (...content: unknown[]) => block("paragraph", { content });
const html = (...blocks: Block[]) => writeBlocks(blocks).html;

describe("text blocks and inline styles", () => {
  test("a paragraph, with every style in a fixed order", () => {
    expect(html(para(text("Hello")))).toBe("<p>Hello</p>");
    expect(
      html(
        para(
          text("x", { bold: true, italic: true, underline: true, strikethrough: true, code: true }),
        ),
      ),
    ).toBe("<p><s><u><em><strong><code>x</code></strong></em></u></s></p>");
    expect(html(para(text("a", { superscript: true }), text("b", { subscript: true })))).toBe(
      "<p><sup>a</sup><sub>b</sub></p>",
    );
  });

  test("safe colours are written, as style values", () => {
    expect(html(para(text("c", { color: "#ff0000", backgroundColor: "rgb(0, 0, 255)" })))).toBe(
      '<p><span style="color:#ff0000;background-color:rgb(0, 0, 255)">c</span></p>',
    );
  });

  test("a link is written with rel, a mention as a span, a new line as <br>", () => {
    expect(html(para({ type: "link", text: "oks", href: "https://example.com/a?b=1&c=2" }))).toBe(
      '<p><a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">oks</a></p>',
    );
    expect(html(para({ type: "mention", text: "@Ada", id: "u1" }))).toBe(
      '<p><span class="mention">@Ada</span></p>',
    );
    expect(html(para(text("a\nb")))).toBe("<p>a<br>b</p>");
  });

  test("headings clamp to levels 1 to 6; alignment is written only for the known values", () => {
    expect(html(block("heading", { props: { level: 3 }, content: [text("T")] }))).toBe(
      "<h3>T</h3>",
    );
    expect(html(block("heading", { props: { level: 99 }, content: [text("T")] }))).toBe(
      "<h6>T</h6>",
    );
    expect(html(block("heading", { content: [text("T")] }))).toBe("<h2>T</h2>");
    expect(html(block("paragraph", { props: { align: "center" }, content: [text("c")] }))).toBe(
      '<p style="text-align:center">c</p>',
    );
    expect(
      html(block("paragraph", { props: { align: 'x" onclick="y' }, content: [text("c")] })),
    ).toBe("<p>c</p>");
  });

  test("quote, callout and toggle", () => {
    expect(html(block("quote", { content: [text("q")] }))).toBe(
      "<blockquote><p>q</p></blockquote>",
    );
    expect(html(block("callout", { props: { variant: "warning" }, content: [text("w")] }))).toBe(
      '<aside class="callout callout-warning"><p>w</p></aside>',
    );
    expect(
      html(block("callout", { props: { variant: 'x"><script>' }, content: [text("w")] })),
    ).toBe('<aside class="callout callout-info"><p>w</p></aside>');
    expect(
      html(block("toggle", { content: [text("More")], children: [para(text("Hidden"))] })),
    ).toBe("<details><summary>More</summary><p>Hidden</p></details>");
  });
});

describe("lists", () => {
  const item = (type: string, value: string, over: Partial<Block> = {}) =>
    block(type, { content: [text(value)], ...over });

  test("neighbouring items of one kind are one list, and another block breaks it", () => {
    expect(html(item("bulletList", "a"), item("bulletList", "b"))).toBe(
      "<ul><li>a</li><li>b</li></ul>",
    );
    expect(html(item("bulletList", "a"), para(text("p")), item("bulletList", "b"))).toBe(
      "<ul><li>a</li></ul><p>p</p><ul><li>b</li></ul>",
    );
    expect(html(item("numberedList", "1"), item("numberedList", "2"))).toBe(
      "<ol><li>1</li><li>2</li></ol>",
    );
    expect(html(item("bulletList", "a"), item("numberedList", "b"))).toBe(
      "<ul><li>a</li></ul><ol><li>b</li></ol>",
    );
  });

  test("a task list has disabled check boxes, and nested items are nested lists", () => {
    expect(
      html(item("taskList", "done", { props: { checked: true } }), item("taskList", "todo")),
    ).toBe(
      '<ul class="task-list"><li><input type="checkbox" disabled checked> done</li><li><input type="checkbox" disabled> todo</li></ul>',
    );
    expect(html(item("bulletList", "a", { children: [item("bulletList", "a1")] }))).toBe(
      "<ul><li>a<ul><li>a1</li></ul></li></ul>",
    );
  });
});

describe("media and other blocks", () => {
  test("an image: checked address, escaped alt, an optional caption", () => {
    expect(html(block("image", { props: { src: "/uploads/a.webp", alt: 'a "b" <c>' } }))).toBe(
      '<figure><img src="/uploads/a.webp" alt="a &quot;b&quot; &lt;c&gt;" loading="lazy"></figure>',
    );
    expect(
      html(
        block("image", { props: { src: "https://x.test/a.png", alt: "x", caption: "Cap <1>" } }),
      ),
    ).toBe(
      '<figure><img src="https://x.test/a.png" alt="x" loading="lazy"><figcaption>Cap &lt;1&gt;</figcaption></figure>',
    );
  });

  test("a video is drawn only from an allowed host, through the privacy-friendly player", () => {
    const frame = (src: string) =>
      `<iframe src="${src}" title="Video" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    expect(
      html(block("video", { props: { src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } })),
    ).toBe(frame("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"));
    expect(html(block("video", { props: { src: "https://youtu.be/dQw4w9WgXcQ" } }))).toBe(
      frame("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"),
    );
    expect(html(block("video", { props: { src: "https://vimeo.com/123456789" } }))).toBe(
      frame("https://player.vimeo.com/video/123456789"),
    );
    expect(html(block("video", { props: { src: "https://evil.test/v.mp4" } }))).toBe("");
    expect(
      html(block("video", { props: { src: "http://www.youtube.com/watch?v=dQw4w9WgXcQ" } })),
    ).toBe("");
  });

  test("embed, file and bookmark are links", () => {
    expect(html(block("embed", { props: { url: "https://example.com/x" } }))).toBe(
      '<p><a href="https://example.com/x" rel="noopener noreferrer">https://example.com/x</a></p>',
    );
    expect(
      html(block("file", { props: { url: "/uploads/r.pdf", name: "Report", size: 2_500_000 } })),
    ).toBe(
      '<p><a href="/uploads/r.pdf" download rel="noopener noreferrer">Report</a> <span class="file-size">2.5 MB</span></p>',
    );
    expect(
      html(
        block("bookmark", {
          props: { url: "https://example.com", title: "Ex", description: "About" },
        }),
      ),
    ).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">Ex</a></p><p>About</p>',
    );
  });

  test("code is escaped text in a language class; a divider is <hr>", () => {
    expect(
      html(
        block("codeBlock", { props: { language: "ts" }, content: [text("if (a < b && c) {}")] }),
      ),
    ).toBe('<pre><code class="language-ts">if (a &lt; b &amp;&amp; c) {}</code></pre>');
    expect(
      html(block("codeBlock", { props: { language: 'x"><script>' }, content: [text("1")] })),
    ).toBe('<pre><code class="language-xscript">1</code></pre>');
    expect(html(block("divider"))).toBe("<hr>");
  });

  test("a table, with an optional header row", () => {
    const rows = [{ cells: [[text("A")], [text("B")]] }, { cells: [[text("1")], [text("2 & 3")]] }];
    expect(html(block("table", { content: { rows } }))).toBe(
      "<table><tbody><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2 &amp; 3</td></tr></tbody></table>",
    );
    expect(html(block("table", { props: { headerRow: true }, content: { rows } }))).toBe(
      '<table><thead><tr><th scope="col">A</th><th scope="col">B</th></tr></thead><tbody><tr><td>1</td><td>2 &amp; 3</td></tr></tbody></table>',
    );
  });

  test("columns hold their children side by side", () => {
    expect(html(block("columns", { children: [para(text("L")), para(text("R"))] }))).toBe(
      '<div class="columns"><div class="column"><p>L</p></div><div class="column"><p>R</p></div></div>',
    );
  });

  test("a block type the writer does not know is left out and reported", () => {
    const written = writeBlocks([
      para(text("a")),
      block("pricing-card"),
      block("pricing-card"),
      block("map"),
    ]);
    expect(written.html).toBe("<p>a</p>");
    expect(written.skipped).toEqual(["map", "pricing-card"]);
  });
});

describe("plain text", () => {
  test("text of every block, one line each, with the alt text of images and the cells of tables", () => {
    const written = writeBlocks([
      block("heading", { props: { level: 1 }, content: [text("Title")] }),
      para(text("One "), text("two", { bold: true })),
      block("bulletList", {
        content: [text("item")],
        children: [block("bulletList", { content: [text("nested")] })],
      }),
      block("image", { props: { src: "/a.png", alt: "A cat" } }),
      block("table", { content: { rows: [{ cells: [[text("x")], [text("y")]] }] } }),
      block("divider"),
      block("pricing-card", { content: [text("hidden plugin text")] }),
    ]);
    expect(written.plainText).toBe("Title\nOne two\nitem\nnested\nA cat\nx y\nhidden plugin text");
  });
});

describe("a decorative picture", () => {
  test("is written with an empty description, and its description is left out of the plain text", () => {
    const decorative = block("image", {
      props: { src: "/a.png", alt: "A cat", decorative: true, caption: "Cap" },
    });
    expect(html(decorative)).toBe(
      '<figure><img src="/a.png" alt="" loading="lazy"><figcaption>Cap</figcaption></figure>',
    );
    expect(writeBlocks([decorative]).plainText).toBe("Cap");
    // Anything but true changes nothing.
    expect(
      html(block("image", { props: { src: "/a.png", alt: "A cat", decorative: "yes" } })),
    ).toBe('<figure><img src="/a.png" alt="A cat" loading="lazy"></figure>');
  });
});

describe("hostile documents (EC-33)", () => {
  const hostile: Block[] = [
    para(text("x", { color: 'red" onmouseover="alert(1)' })),
    para(text("x", { backgroundColor: "url(javascript:alert(9))" })),
    para({ type: "link", text: "a", href: "javascript:alert(1)" }),
    para({ type: "link", text: "a", href: " jav\tascript:alert(1)" }),
    para({ type: "link", text: "a", href: 'https://x.test/" onclick="alert(1)' }),
    para({ type: "link", text: '"><script>alert(1)</script>', href: "https://x.test" }),
    para(text("<img src=x onerror=alert(1)>")),
    block("image", { props: { src: "javascript:alert(1)", alt: "x" } }),
    block("image", { props: { src: 'x.png" onerror="alert(1)', alt: '" onload="alert(1)' } }),
    block("image", { props: { src: "data:text/html,<script>alert(1)</script>", alt: "x" } }),
    block("video", { props: { src: "javascript:alert(1)" } }),
    block("video", { props: { src: 'https://www.youtube.com/watch?v=x"onload="alert(1)' } }),
    block("embed", { props: { url: "javascript:alert(1)" } }),
    block("file", { props: { url: "vbscript:x", name: "<b onmouseover=alert(1)>f</b>" } }),
    block("bookmark", {
      props: { url: "data:text/html;base64,PHNjcmlwdD4=", title: "<script>t</script>" },
    }),
    block("codeBlock", {
      props: { language: 'js" onclick="x' },
      content: [text("</code><script>alert(1)</script>")],
    }),
    block("table", { content: { rows: [{ cells: [[text("<script>alert(1)</script>")]] }] } }),
    block("callout", {
      props: { variant: '"><img src=x onerror=alert(1)>' },
      content: [text("c")],
    }),
    block("paragraph", {
      props: { align: "center;background:url(javascript:alert(1))" },
      content: [text("a")],
    }),
  ];

  const unsafe = (out: string): string[] => {
    const problems: string[] = [];
    // A tag with an event handler: an attribute named on... Quoted values are emptied first, so text that only
    // looks like an attribute inside a properly quoted value is not mistaken for one.
    const tags = out.replace(/"[^"]*"/g, '""');
    if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(tags)) problems.push("event handler");
    if (/<script/i.test(out)) problems.push("script tag");
    if (/(?:href|src)\s*=\s*"\s*(?:javascript|vbscript|data):/i.test(out))
      problems.push("script address");
    if (/url\(/i.test(out)) problems.push("css url()");
    return problems;
  };

  test("the writer alone (no block checks) never writes an event handler, a script or a script address", () => {
    for (const [i, b] of hostile.entries()) {
      const out = html(b);
      expect(unsafe(out), `case ${i}: ${out}`).toEqual([]);
    }
  });

  test("after the block checks too: the two layers agree", () => {
    const { body } = checkBlocks({ version: 1, blocks: hostile });
    expect(unsafe(writeBlocks(body.blocks).html)).toEqual([]);
  });

  test('escaping: text and attribute values never keep a raw < > " or &', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
    expect(html(para(text("<b>&")))).toBe("<p>&lt;b&gt;&amp;</p>");
  });

  test("a document nested deeper than the limit is cut, not followed forever", () => {
    let deep = para(text("bottom"));
    for (let i = 0; i < 40; i++) deep = block("quote", { content: [text("q")], children: [deep] });
    const out = html(deep);
    expect(out).not.toContain("bottom");
    expect(out.length).toBeLessThan(5000);
  });

  test("odd input does not throw", () => {
    expect(() => writeBlocks([null, undefined, 5, { type: "paragraph" }] as never)).not.toThrow();
    expect(writeBlocks([] as Block[])).toEqual({ html: "", plainText: "", skipped: [] });
  });
});
