import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  MAX_EXPANDED_BLOCKS,
  SECTION_GROUP_LABELS,
  SECTION_GROUPS,
  checkThemePackage,
  sectionGroup,
  type PackageCheck,
} from "./theme-package.js";

// ----- a tiny tar writer, so the tests can build good and hostile packages

interface Item {
  path: string;
  data?: Buffer | string;
  /** The tar type character: "0" file, "5" folder, "1" hard link, "2" symbolic link, "3" device, "6" pipe. */
  type?: string;
}

function header(path: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(path.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.fill(32, 148, 156);
  h.write(type, 156);
  h.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}
const padded = (data: Buffer): Buffer =>
  Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

function pax(path: string): Buffer {
  const body = ` path=${path}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
  const data = Buffer.from(`${length}${body}`);
  return Buffer.concat([header("PaxHeader", data.length, "x"), padded(data)]);
}

function tar(items: Item[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    const data = Buffer.from(item.data ?? "");
    const type = item.type ?? "0";
    if (item.path.length > 100) parts.push(pax(item.path));
    parts.push(header(item.path, type === "0" ? data.length : 0, type));
    if (type === "0") parts.push(padded(data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
const tgz = (items: Item[]): Buffer => gzipSync(tar(items));

// ----- good material

const manifest = {
  key: "maple",
  name: "Maple",
  version: "1.2.0",
  description: "A warm theme.",
  rtl: "supported",
  tokens: { color: { "primary-700": "#2a6f4f", text: "#222222" }, font: { body: "system-serif" } },
  options: ["mainColor", "logo"],
  fonts: [{ family: "Maple Sans", weight: 400, file: "assets/maple.woff2" }],
};
const png = Buffer.from("iVBORw0KGgo=", "base64");
const layout = (blocks: unknown[]) => JSON.stringify({ blocks });
const block = (type: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({
  id: Math.random().toString(36).slice(2, 10),
  type,
  props,
  content: null,
  children,
});
const part = (name: string) => block("part", { name });

const good = (): Item[] => [
  { path: "theme.json", data: JSON.stringify(manifest) },
  {
    path: "styles/theme.css",
    data: "/* c */ body { background: url(assets/bg.png) } .a { margin-inline-start: 1rem }",
  },
  { path: "assets/bg.png", data: png },
  { path: "assets/maple.woff2", data: "wOF2" },
  { path: "screenshot.png", data: png },
  { path: "README.md", data: "# Maple" },
  { path: "templates/index.json", data: layout([part("header"), block("post-content")]) },
  {
    path: "templates/single-post.json",
    data: layout([part("header"), block("post-title"), block("post-content")]),
  },
  {
    path: "parts/header.json",
    data: layout([block("site-logo"), block("menu", { place: "primary" })]),
  },
  {
    path: "patterns/hero.json",
    data: JSON.stringify({ title: "Hero", blocks: [block("heading")] }),
  },
];

const refusedWith = (check: PackageCheck, text: string | RegExp) => {
  expect(check.ok, JSON.stringify(check.report.refused)).toBe(false);
  expect(check.report.refused.join(" | ")).toMatch(text);
};

describe("a good package", () => {
  test("passes, with the theme read out of it", () => {
    const check = checkThemePackage(tgz(good()));
    expect(check.ok, JSON.stringify(check.report)).toBe(true);
    if (!check.ok) return;
    const theme = check.theme;
    expect(theme).toMatchObject({
      key: "maple",
      name: "Maple",
      version: "1.2.0",
      rtl: "supported",
      options: ["mainColor", "logo"],
    });
    expect(theme.tokens.color?.["primary-700"]).toBe("#2a6f4f");
    expect(theme.fonts).toEqual([
      { family: "Maple Sans", weight: 400, style: "normal", file: "assets/maple.woff2" },
    ]);
    expect(theme.css).toContain("url(assets/bg.png)");
    expect(theme.css).not.toContain("/* c */");
    expect(theme.templates.map((t) => t.name)).toEqual(["index", "single-post"]);
    expect(theme.parts.map((p) => p.name)).toEqual(["header"]);
    expect(theme.patterns[0]).toMatchObject({ name: "hero", title: "Hero" });
    expect([...theme.assets.keys()].sort()).toEqual([
      "assets/bg.png",
      "assets/maple.woff2",
      "screenshot.png",
    ]);
    expect(check.report.refused).toEqual([]);
    expect(check.report.passed.length).toBeGreaterThan(2);
  });

  test("works with a package/ folder around it (npm pack) and with ./ in front of the paths", () => {
    expect(
      checkThemePackage(tgz(good().map((i) => ({ ...i, path: `package/${i.path}` })))).ok,
    ).toBe(true);
    expect(checkThemePackage(tgz(good().map((i) => ({ ...i, path: `./${i.path}` })))).ok).toBe(
      true,
    );
  });

  test("a folder entry, and an entry with a long path made by a pax header, are read", () => {
    const items = [{ path: "styles", type: "5" }, ...good()];
    expect(checkThemePackage(tgz(items)).ok).toBe(true);
    const long = `assets/${"a".repeat(120)}.png`;
    const check = checkThemePackage(tgz([...good(), { path: long, data: png }]));
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.theme.assets.has(long)).toBe(true);
  });

  test("a theme with nothing but theme.json is a theme", () => {
    const check = checkThemePackage(
      tgz([
        {
          path: "theme.json",
          data: JSON.stringify({ key: "bare", name: "Bare", version: "0.1.0" }),
        },
      ]),
    );
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.report.warnings.join(" ")).toContain("right-to-left");
  });
});

describe("a package that is not safe (TH-19 to TH-32)", () => {
  const withExtra = (...extra: Item[]) => tgz([...good(), ...extra]);

  test("paths that leave the theme", () => {
    for (const path of [
      "../evil.json",
      "templates/../../evil.json",
      "/etc/evil.json",
      "C:/evil.json",
      "a\\b.json",
      "a//b.json",
      "a/./b.json",
      "x/\u0001.json",
    ])
      refusedWith(
        checkThemePackage(withExtra({ path, data: "{}" })),
        /path|absolute|backslash|control|"\.|empty/,
      );
    refusedWith(
      checkThemePackage(withExtra({ path: `assets/${"a".repeat(250)}.png`, data: png })),
      /longer than 200/,
    );
  });

  test("links, devices and pipes", () => {
    for (const type of ["1", "2", "3", "4", "6"])
      refusedWith(
        checkThemePackage(withExtra({ path: "assets/link.png", type })),
        /links, devices/,
      );
  });

  test("code, markup, pictures that carry script, and files with no extension or a strange one", () => {
    for (const path of [
      "a.php",
      "a.html",
      "a.htm",
      "a.svg",
      "a.js",
      "a.mjs",
      "a.ts",
      "a.wasm",
      "LICENSE",
      "assets/.hidden",
      "a.exe",
      "a.zip",
      "a.gif",
      "a.ttf",
    ])
      refusedWith(
        checkThemePackage(withExtra({ path, data: "x" })),
        /not allowed|needs an extension/,
      );
  });

  test("the same file twice", () => {
    refusedWith(checkThemePackage(withExtra({ path: "README.md", data: "again" })), /twice/);
  });

  test("too many files", () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ path: `assets/f${i}.png`, data: png }));
    refusedWith(checkThemePackage(withExtra(...many)), /most allowed is 500/);
  });

  test("a decompression bomb (25 MB packed into a few KB) is stopped while it is unzipped", () => {
    const bomb = tgz([{ path: "assets/big.png", data: Buffer.alloc(25 * 1024 * 1024) }]);
    expect(bomb.length).toBeLessThan(100 * 1024);
    const started = Date.now();
    refusedWith(checkThemePackage(bomb), /too large when unpacked/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("files that add up to more than 20 MB", () => {
    const four = Array.from({ length: 5 }, (_, i) => ({
      path: `assets/f${i}.png`,
      data: Buffer.alloc(4.5 * 1024 * 1024, i + 1),
    }));
    refusedWith(
      checkThemePackage(tgz([...good(), ...four])),
      /the most allowed is 20 MB|too large/,
    );
  });

  test("not a .tgz, damaged, or cut short", () => {
    refusedWith(checkThemePackage(Buffer.from("PK\u0003\u0004 a zip")), /not a \.tgz/);
    refusedWith(
      checkThemePackage(gzipSync(Buffer.from("this is not a tar file".repeat(100)))),
      /damaged/,
    );
    const cut = tar(good()).subarray(0, 700);
    refusedWith(checkThemePackage(gzipSync(cut)), /cut short|damaged/);
    refusedWith(checkThemePackage(Buffer.alloc(0)), /not a \.tgz/);
  });
});

describe("theme.json", () => {
  const withManifest = (value: unknown, ...extra: Item[]) =>
    checkThemePackage(
      tgz([
        { path: "theme.json", data: typeof value === "string" ? value : JSON.stringify(value) },
        ...extra,
      ]),
    );
  const base = { key: "t", name: "T", version: "1.0.0" };

  test("must be there, must be JSON, must be an object", () => {
    refusedWith(checkThemePackage(tgz([{ path: "README.md", data: "x" }])), /no theme\.json/);
    refusedWith(withManifest("{ not json"), /not valid JSON/);
    refusedWith(withManifest([]), /must be an object/);
  });

  test("key, name and version are required and plain", () => {
    refusedWith(withManifest({ name: "T", version: "1.0.0" }), /"key"/);
    refusedWith(withManifest({ ...base, key: "Bad Key" }), /"key" must be lower-case/);
    refusedWith(withManifest({ ...base, name: "" }), /"name"/);
    refusedWith(withManifest({ ...base, version: "latest" }), /"version"/);
    refusedWith(withManifest({ ...base, rtl: "yes" }), /"rtl"/);
  });

  test("tokens are checked like every other design value", () => {
    refusedWith(
      withManifest({ ...base, tokens: { color: { text: "red;}body{display:none" } } }),
      /not a color/,
    );
    refusedWith(
      withManifest({ ...base, tokens: { color: { "primary-701": "#fff" } } }),
      /not a name/,
    );
    refusedWith(
      withManifest({ ...base, tokens: { font: { body: "</style><script>x</script>" } } }),
      /not a plain font name/,
    );
  });

  test("options, fonts and unknown keys", () => {
    refusedWith(
      withManifest({ ...base, options: ["mainColor", "everything"] }),
      /"everything" is not something an owner can change/,
    );
    refusedWith(
      withManifest({ ...base, fonts: [{ family: "X", file: "assets/x.woff2" }] }),
      /needs a \.woff2 file that is in the package/,
    );
    refusedWith(
      withManifest(
        { ...base, fonts: [{ family: "X", file: "assets/x.png" }] },
        { path: "assets/x.png", data: png },
      ),
      /\.woff2/,
    );
    refusedWith(
      withManifest(
        { ...base, fonts: [{ family: 'X"; }', file: "assets/x.woff2" }] },
        { path: "assets/x.woff2", data: "w" },
      ),
      /plain family name/,
    );
    refusedWith(
      withManifest(
        { ...base, fonts: [{ family: "X", weight: 450, file: "assets/x.woff2" }] },
        { path: "assets/x.woff2", data: "w" },
      ),
      /weight/,
    );
    const check = withManifest({ ...base, extra: 1 });
    expect(check.ok).toBe(true);
    expect(check.report.warnings.join(" ")).toContain('"extra" is not used');
  });

  test("a package.json that says it is not a theme", () => {
    refusedWith(
      withManifest(base, {
        path: "package.json",
        data: JSON.stringify({ oksPage: { type: "plugin" } }),
      }),
      /oksPage\.type/,
    );
    expect(
      withManifest(base, {
        path: "package.json",
        data: JSON.stringify({ oksPage: { type: "theme" } }),
      }).ok,
    ).toBe(true);
  });
});

describe("the CSS of a package (TH-06 to TH-17)", () => {
  const withCss = (css: string, ...extra: Item[]) =>
    checkThemePackage(
      tgz([
        ...good().filter((i) => i.path !== "styles/theme.css"),
        { path: "styles/theme.css", data: css },
        ...extra,
      ]),
    );

  test("hostile CSS is refused with its line", () => {
    for (const css of [
      "@import 'x.css';",
      "a{background:url(https://evil.example/x)}",
      "a{background:url(../secret.png)}",
      "a{background:url(assets/missing.png)}",
      "a{background:url(README.md)}",
      "a{width:expression(1)}",
      "a{color:red}</style><script>x</script>",
      "@namespace svg url(http://x);",
      "a{color:red",
    ])
      refusedWith(withCss(css), /styles\/theme\.css: /);
    refusedWith(withCss("a{}\n\n@import 'x';"), /Line 3/);
  });

  test("a font face and a picture that are in the package are fine", () => {
    expect(
      withCss("@font-face{font-family:Maple Sans;src:url(assets/maple.woff2);font-display:swap}")
        .ok,
    ).toBe(true);
  });

  test("a file over 300 KB", () => {
    refusedWith(withCss("a{color:red}\n".repeat(30_000)), /the most allowed is 300 KB/);
  });

  test("left and right in the CSS are a warning for right-to-left sites, and do not stop the theme", () => {
    const check = withCss(
      "a{margin-left:1rem;float:left;text-align:right} b{border-top-left-radius:4px} .c{left:0}",
    );
    expect(check.ok).toBe(true);
    const text = check.report.warnings.join(" ");
    for (const word of [
      "margin-left",
      "float:left",
      "text-align:right",
      "border-top-left-radius",
      "left:",
    ])
      expect(text).toContain(word);
    expect(
      withCss("a{margin-inline-start:1rem;inset-inline-start:0}").report.warnings.join(" "),
    ).not.toContain("left or the right");
  });

  test("other css files are not used and say so", () => {
    const check = withCss("a{}", { path: "styles/extra.css", data: "b{}" });
    expect(check.ok).toBe(true);
    expect(check.report.warnings.join(" ")).toContain("only styles/theme.css is used");
  });
});

describe("templates, parts and patterns (TH-33 to TH-37)", () => {
  const without = (...paths: string[]) => good().filter((i) => !paths.includes(i.path));
  const check = (...items: Item[]) =>
    checkThemePackage(tgz([...without(...items.map((i) => i.path)), ...items]));

  test("a part that is not in the theme", () => {
    refusedWith(
      checkThemePackage(tgz(without("parts/header.json"))),
      /the part "header" is not in the theme/,
    );
    refusedWith(
      check({ path: "templates/index.json", data: layout([part("footer")]) }),
      /"footer"/,
    );
  });

  test("a part block with no name", () => {
    refusedWith(
      check({ path: "templates/index.json", data: layout([block("part")]) }),
      /needs a name/,
    );
    refusedWith(
      check({ path: "templates/index.json", data: layout([block("part", { name: "../x" })]) }),
      /needs a name/,
    );
  });

  test("a part that includes itself, and a loop of parts", () => {
    refusedWith(
      check({ path: "parts/header.json", data: layout([part("header")]) }),
      /includes itself/,
    );
    refusedWith(
      check(
        { path: "parts/a.json", data: layout([part("b")]) },
        { path: "parts/b.json", data: layout([part("a")]) },
      ),
      /includes itself/,
    );
  });

  test("parts that multiply each other are stopped at the limit, and fast", () => {
    // 20 parts, each including the next one twice: one template would become about a million blocks.
    const chain: Item[] = Array.from({ length: 20 }, (_, i) => ({
      path: `parts/p${i}.json`,
      data: layout(i === 19 ? [block("paragraph")] : [part(`p${i + 1}`), part(`p${i + 1}`)]),
    }));
    const started = Date.now();
    const result = check({ path: "templates/index.json", data: layout([part("p0")]) }, ...chain);
    refusedWith(result, new RegExp(`more than ${MAX_EXPANDED_BLOCKS} blocks`));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("parts nested 6 deep pass; 7 deep do not", () => {
    const chain = (n: number): Item[] =>
      Array.from({ length: n }, (_, i) => ({
        path: `parts/q${i}.json`,
        data: layout(i === n - 1 ? [block("paragraph")] : [part(`q${i + 1}`)]),
      }));
    expect(
      check({ path: "templates/index.json", data: layout([part("q0")]) }, ...chain(6)).ok,
    ).toBe(true);
    refusedWith(
      check({ path: "templates/index.json", data: layout([part("q0")]) }, ...chain(7)),
      /nested more than 6 levels/,
    );
  });

  test("an unsafe link in a layout is repaired by the block checks and reported", () => {
    const linked = {
      ...block("paragraph"),
      content: [
        { type: "link", href: "javascript:alert(1)", content: [{ type: "text", text: "x" }] },
      ],
    };
    const result = check({ path: "templates/index.json", data: layout([linked, part("header")]) });
    expect(result.ok).toBe(true);
    expect(result.report.warnings.join(" ")).toMatch(
      /templates\/index\.json: \d+ things? (was|were) repaired/,
    );
    if (result.ok) expect(JSON.stringify(result.theme.templates)).not.toContain("javascript:");
  });

  test("a layout that is not a list of blocks, a bad name, a folder inside", () => {
    refusedWith(check({ path: "templates/index.json", data: "{}" }), /list of "blocks"/);
    refusedWith(check({ path: "templates/Index.json", data: layout([]) }), /lower-case/);
    const nested = check({ path: "templates/deep/page.json", data: layout([]) });
    expect(nested.ok).toBe(true);
    expect(nested.report.warnings.join(" ")).toContain(
      "only .json files directly in templates/ are used",
    );
  });

  test("block kinds this site does not draw are kept and mentioned", () => {
    const result = check({
      path: "templates/index.json",
      data: layout([block("fancy-slider"), part("header")]),
    });
    expect(result.ok).toBe(true);
    expect(result.report.warnings.join(" ")).toMatch(
      /1 block in the layouts is of a kind this site does not draw|1 block in the layouts is of kinds/,
    );
  });

  test("each ready-made section has a group of the library; an unknown or missing one is Other", () => {
    const result = check(
      {
        path: "patterns/hero.json",
        data: JSON.stringify({ title: "Big welcome", group: "hero", blocks: [block("heading")] }),
      },
      {
        path: "patterns/prices.json",
        data: JSON.stringify({
          title: "Prices",
          group: "pricing-tables",
          blocks: [block("heading")],
        }),
      },
      { path: "patterns/plain.json", data: layout([block("heading")]) },
    );
    expect(result.ok, JSON.stringify(result.report)).toBe(true);
    if (!result.ok) return;
    expect(result.theme.patterns.map((p) => [p.name, p.title, p.group])).toEqual([
      ["hero", "Big welcome", "hero"],
      ["plain", "plain", "other"],
      ["prices", "Prices", "other"],
    ]);
    expect(result.report.warnings.join(" ")).toContain(
      'patterns/prices.json: the group "pricing-tables" is not one the library knows',
    );
    expect(sectionGroup("call-to-action")).toBe("call-to-action");
    expect(sectionGroup(undefined)).toBe("other");
    expect(SECTION_GROUPS.map((g) => SECTION_GROUP_LABELS[g])).toEqual([
      "Hero",
      "Text",
      "Pictures",
      "Gallery",
      "Prices",
      "Reviews",
      "Team",
      "Contact",
      "Map",
      "Call to action",
      "Blog posts",
      "Other",
    ]);
  });
});
