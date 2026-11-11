import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { cleanSvg, MAX_SVG_BYTES, SvgRefused } from "./svg.js";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const NSX = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
const enc = (s: string) => new TextEncoder().encode(s);
const wrap = (inner: string, attrs = "") =>
  `<svg ${NS} ${NSX} viewBox="0 0 10 10" ${attrs}>${inner}</svg>`;

// The hostile files (SVG-01 and SVG-02): each one runs code or calls another host when opened raw.
const hostile: Record<string, string> = {
  script: wrap("<script>alert(1)</script>"),
  "upper case script": wrap("<SCRIPT>alert(1)</SCRIPT>"),
  "namespaced script": `<svg ${NS}><x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script></svg>`,
  "CDATA script": wrap("<script><![CDATA[alert(1)]]></script>"),
  onload: wrap("<rect width='1' height='1'/>", 'onload="alert(1)"'),
  onclick: wrap("<rect width='1' height='1' onclick='alert(1)'/>"),
  onbegin: wrap("<rect width='1' height='1' onbegin='alert(1)'/>"),
  "javascript href": wrap("<a href='javascript:alert(1)'><rect width='1' height='1'/></a>"),
  "javascript xlink:href": wrap(
    "<a xlink:href='javascript:alert(1)'><rect width='1' height='1'/></a>",
  ),
  "data href": wrap("<a href='data:text/html,<script>alert(1)</script>'><rect/></a>"),
  foreignObject: wrap(
    "<foreignObject><div xmlns='http://www.w3.org/1999/xhtml'><script>alert(1)</script></div></foreignObject>",
  ),
  "external use": wrap("<use href='https://evil.example/x.svg#a'/>"),
  "external use xlink": wrap("<use xlink:href='https://evil.example/x.svg#a'/>"),
  "@import": wrap("<style>@import url(https://evil.example/a.css);</style>"),
  "style attribute with outside url": wrap(
    "<rect width='1' height='1' style='fill:url(https://evil.example/a)'/>",
  ),
  "animate sets a link": wrap(
    "<a href='#'><animate attributeName='href' values='javascript:alert(1)'/><rect/></a>",
  ),
  "set sets an event": wrap(
    "<rect width='1' height='1'><set attributeName='onmouseover' to='alert(1)'/></rect>",
  ),
  animateTransform: wrap(
    "<rect width='1' height='1'><animateTransform attributeName='transform' onbegin='alert(1)'/></rect>",
  ),
  "external image": wrap("<image href='https://evil.example/pixel.png' width='1' height='1'/>"),
  iframe: wrap("<iframe src='https://evil.example/'/>"),
  feImage: wrap(
    "<filter id='f'><feImage href='https://evil.example/p.png'/></filter><rect filter='url(#f)'/>",
  ),
  "outside fill url": wrap("<rect width='1' height='1' fill='url(https://evil.example/p.svg#a)'/>"),
  "mutation markup": wrap('<style><img title="</style><img src onerror=alert(1)>"></style><rect/>'),
  "embedded html object": wrap("<object data='https://evil.example/x'/>"),
};

// What must not be in a cleaned file, found by reading it back as XML.
async function problems(cleaned: string): Promise<string[]> {
  const { JSDOM } = await import("jsdom");
  let doc: Document;
  try {
    doc = new JSDOM(cleaned, { contentType: "image/svg+xml" }).window.document;
  } catch {
    return ["not well formed"];
  }
  const found: string[] = [];
  const bad = new Set([
    "script",
    "foreignobject",
    "use",
    "style",
    "a",
    "image",
    "iframe",
    "animate",
    "set",
    "animatetransform",
    "feimage",
    "object",
    "embed",
  ]);
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    const tag = el.localName.toLowerCase();
    if (bad.has(tag)) found.push(`tag ${tag}`);
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      const v = a.value.trim();
      if (n.startsWith("on")) found.push(`event ${n}`);
      if (n === "style") found.push("style attribute");
      if ((n === "href" || n.endsWith(":href")) && !v.startsWith("#")) found.push(`link ${n}=${v}`);
      if (/url\s*\(/i.test(v) && !/^url\(\s*['"]?#[^)]*\)$/i.test(v)) found.push(`url in ${n}`);
      if (/^(javascript|vbscript|data):/i.test(v)) found.push(`script address in ${n}`);
    }
  }
  if (/<script|javascript:|evil\.example/i.test(cleaned)) found.push("text left in output");
  return found;
}

describe("24 hostile files come out clean (SVG-01, SVG-02, SVG-04)", () => {
  test.each(Object.entries(hostile))("%s", async (_name, source) => {
    let cleaned: string;
    try {
      cleaned = await cleanSvg(enc(source));
    } catch (error) {
      // Refusing the file is also safe.
      expect(error).toBeInstanceOf(SvgRefused);
      return;
    }
    expect(await problems(cleaned)).toEqual([]);
  });

  test("the control: the checker does find the problems in the raw files", async () => {
    let dangerous = 0;
    for (const source of Object.values(hostile)) {
      if ((await problems(source)).length > 0) dangerous += 1;
    }
    expect(dangerous).toBeGreaterThanOrEqual(20);
  });
});

describe("files that are refused (SVG-05, SVG-09)", () => {
  test("an entity definition (billion laughs)", async () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]><svg ${NS}><text>&b;</text></svg>`;
    await expect(cleanSvg(enc(laughs))).rejects.toThrow(/entities/);
  });
  test("an external entity", async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg ${NS}><text>&x;</text></svg>`;
    await expect(cleanSvg(enc(xxe))).rejects.toThrow(/entities/);
  });
  test("a DOCTYPE with an internal subset", async () => {
    await expect(cleanSvg(enc(`<!DOCTYPE svg [ ]><svg ${NS}/>`))).rejects.toThrow(/entities/);
  });
  test("a file over 200 KB", async () => {
    const big = wrap(`<!-- ${"x".repeat(MAX_SVG_BYTES)} -->`);
    await expect(cleanSvg(enc(big))).rejects.toThrow(/too big/);
  });
  test("something that is not an SVG", async () => {
    await expect(cleanSvg(enc("<html><body>hello</body></html>"))).rejects.toBeInstanceOf(
      SvgRefused,
    );
  });
});

describe("good files are kept (SVG-06 to SVG-08)", () => {
  const logo = wrap(
    `<defs>
       <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6600"/><stop offset="1" stop-color="#3366ff"/></linearGradient>
       <clipPath id="c"><circle cx="5" cy="5" r="4"/></clipPath>
     </defs>
     <g clip-path="url(#c)"><rect width="10" height="10" fill="url(#g)"/></g>
     <path d="M1 9 L5 6 L9 9 Z" fill="#fff" stroke="#000" stroke-width="0.2"/>
     <text x="1" y="2" font-size="2" fill="#222">OKS</text>`,
    'width="100" height="100"',
  );

  test("shapes, gradients, clip paths and text stay", async () => {
    const cleaned = await cleanSvg(enc(logo));
    for (const part of [
      "linearGradient",
      "clipPath",
      "<path",
      "<text",
      "<rect",
      "<circle",
      "viewBox",
    ]) {
      expect(cleaned).toContain(part);
    }
    expect(cleaned).toContain('fill="url(#g)"');
    expect(cleaned).toContain('clip-path="url(#c)"');
    expect(cleaned).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(await problems(cleaned)).toEqual([]);
  });

  test("the logo looks the same before and after cleaning (pixel-identical)", async () => {
    const draw = (svg: string) =>
      sharp(Buffer.from(svg)).resize(100, 100).raw().toBuffer({ resolveWithObject: false });
    const before = await draw(logo);
    const after = await draw(await cleanSvg(enc(logo)));
    expect(Buffer.compare(before, after)).toBe(0);
  });

  test("the cleaned file still draws as an image", async () => {
    const cleaned = await cleanSvg(enc(logo));
    const m = await sharp(Buffer.from(cleaned)).metadata();
    expect(m.format).toBe("svg");
    expect(m.width).toBe(100);
  });

  test("a file without a namespace gets one", async () => {
    const cleaned = await cleanSvg(
      enc('<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'),
    );
    expect(cleaned).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  test("an xml line and a normal DOCTYPE are fine", async () => {
    const file = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg ${NS} viewBox="0 0 1 1"><rect width="1" height="1"/></svg>`;
    const cleaned = await cleanSvg(enc(file));
    expect(cleaned).toContain("<rect");
    expect(cleaned).not.toContain("DOCTYPE");
  });
});
