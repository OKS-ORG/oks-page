import { describe, expect, test } from "vitest";
import { CUSTOM_CSS_MAX_BYTES, checkThemeCss, describeCssProblems } from "./css-check.js";
import { stylesToCss, DEFAULT_THEME_STYLES } from "./theme.js";

const ok = (css: string, options = {}) => {
  const result = checkThemeCss(css, options);
  if (!result.ok) throw new Error(describeCssProblems(result.errors));
  return result.css;
};
const refused = (css: string, options = {}) => {
  const result = checkThemeCss(css, options);
  expect(result.ok, css.slice(0, 80)).toBe(false);
  return result.ok ? [] : result.errors;
};

describe("CSS that is accepted", () => {
  test("ordinary rules, media, supports, layers, containers and keyframes", () => {
    const css = `
      a { color: #123; }
      @layer base { h1 { margin: 0 } }
      @media (min-width: 40rem) { .x > p:not(.y)::after { content: "}"; } }
      @supports (display: grid) { .g { display: grid } }
      @container (min-width: 20rem) { .c { padding: 1rem } }
      @keyframes spin { from { opacity: 0 } to { opacity: 1 } }
      .pic { background: url(data:image/png;base64,iVBORw0KGgo=) }
      a[href^="https://example.com"] { color: red }
    `;
    expect(ok(css)).toContain("@keyframes spin");
  });

  test("comments are taken out, and what is inside quotes is left alone", () => {
    const css = ok(
      'a{color:red}/* url(https://evil.example/x) */ b::before{content:"/* not a comment */"}',
    );
    expect(css).not.toContain("evil.example");
    expect(css).toContain('"/* not a comment */"');
  });

  test("a text in quotes may hold words that would be refused outside it", () => {
    expect(
      ok('a::after { content: "@import javascript: expression( </x"; }'.replace("</x", "x")),
    ).toContain("@import");
  });

  test("files inside the theme are allowed only for a theme package", () => {
    expect(ok("a{background:url(images/bg.png)}", { themeFiles: true })).toContain("images/bg.png");
    expect(
      ok("@font-face{font-family:X;src:url(fonts/x.woff2)}", {
        themeFiles: true,
        allowFontFace: true,
      }),
    ).toContain("font-face");
    refused("a{background:url(images/bg.png)}");
    refused("@font-face{font-family:X}");
  });
});

describe("CSS that is refused", () => {
  test("at-rules outside the short list", () => {
    for (const css of [
      '@import "x.css";',
      "@import url(https://evil.example/x.css);",
      "@IMPORT 'a.css';",
      '@namespace svg url("http://www.w3.org/2000/svg");',
      "@page { margin: 0 }",
      '@property --x { syntax: "<length>"; inherits: false; initial-value: 0 }',
      '@charset "utf-8";',
      "@font-face { font-family: X }",
      "@scope (.a) { b { color: red } }",
      "@",
    ])
      refused(css);
  });

  test("addresses that load from outside, in every place a browser reads one", () => {
    for (const css of [
      "a{background:url(https://evil.example/x.png)}",
      'a{background:url("//evil.example/x.png")}',
      "a{background:url(http://evil.example/x)}",
      "a{background:url(javascript:alert(1))}",
      "a{background:url(data:text/html;base64,PHNjcmlwdD4=)}",
      "a{background:url(data:image/svg+xml;base64,PHN2Zz4=)}",
      "a{background:url(/etc/passwd)}",
      "a{background:url(../secret.png)}",
      "a{background:url(images/bg.png)}",
      "a{list-style:url(https://evil.example/x)}",
      "a{cursor:url(https://evil.example/x), auto}",
      'a{background-image:image-set("https://evil.example/x.png" 1x)}',
      "a{background:-webkit-image-set(url(data:image/png;base64,AA==) 1x)}",
      'a{background:src("https://evil.example/x")}',
      "a{background:url(x.png) , url( 'https://evil.example/y' )}",
      "a{background:url(a b)}",
    ])
      refused(css);
  });

  test("script and attack features", () => {
    for (const css of [
      "a{width:expression(alert(1))}",
      "a{behavior:url(x.htc)}",
      "a{-moz-binding:url(x.xml#y)}",
      "a{background:javascript:alert(1)}",
      "a{background:vbscript:x}",
    ])
      refused(css);
  });

  test("text that could break out of the style tag", () => {
    for (const css of [
      "a{color:red}</style><script>alert(1)</script>",
      "a{color:red}</STYLE>",
      "<script>alert(1)</script>",
      "a{color:red}<!-- x -->",
      'a::after{content:"</style>"}',
    ])
      refused(css);
  });

  test("escapes that could hide a word, and control characters", () => {
    for (const css of [
      "a{background:\\75rl(https://evil.example/x)}",
      "@\\69mport 'x.css';",
      "a{width:ex\\pression(1)}",
      "a{color:red}\u0000",
      "a{color:red}\u0007",
    ])
      refused(css);
  });

  test("CSS that does not parse", () => {
    for (const css of [
      "a{color:red",
      "a{color:red}}",
      "a{(}",
      "a{content:'abc}",
      "/* never closed a{color:red}",
      "a{background:url(x.png}",
      "a{background:url(",
      "a{ ) }",
    ])
      refused(css);
  });

  test("more than the limit", () => {
    const errors = refused("a{color:red}".repeat(CUSTOM_CSS_MAX_BYTES / 10));
    expect(errors[0]!.message).toContain("KB");
    expect(checkThemeCss("a{color:red}".repeat(100), { maxBytes: 100 }).ok).toBe(false);
  });

  test("an image written into the CSS that is too big", () => {
    refused(`a{background:url(data:image/png;base64,${"A".repeat(27_100)})}`);
    expect(checkThemeCss(`a{background:url(data:image/png;base64,${"A".repeat(26_000)})}`).ok).toBe(
      true,
    );
  });

  test("the problems say on which line", () => {
    const errors = refused("a{color:red}\nb{color:blue}\n@import 'x';\n");
    expect(errors).toEqual([{ line: 3, message: '"@import" is not allowed here.' }]);
    expect(describeCssProblems(errors)).toBe('Line 3: "@import" is not allowed here.');
  });
});

describe("custom CSS in the written look", () => {
  test("comes after the look, and only when it passes the check", () => {
    const base = { ...DEFAULT_THEME_STYLES };
    expect(stylesToCss({ ...base, customCss: "h1{letter-spacing:.1em}" })).toBe(
      "h1{letter-spacing:.1em}",
    );
    const css = stylesToCss({
      ...base,
      mainColor: "#2a6f4f",
      customCss: "h1{letter-spacing:.1em}",
    });
    expect(css.indexOf("--oks-color-primary-700")).toBeLessThan(css.indexOf("letter-spacing"));
    // Whatever was stored, text that fails the check is never written.
    expect(stylesToCss({ ...base, customCss: "@import 'x.css';</style>" })).toBe("");
  });
});
