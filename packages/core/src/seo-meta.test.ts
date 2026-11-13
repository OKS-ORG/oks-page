import { describe, expect, test } from "vitest";
import {
  SEO_DESCRIPTION_MAX,
  absolutizeHtml,
  buildAtom,
  buildRss,
  excerptOf,
  firstImageOf,
  jsonLd,
  postStructuredData,
  readEntrySeo,
  websiteStructuredData,
  type FeedInfo,
  type FeedItem,
} from "./seo-meta.js";

describe("the description made from a text", () => {
  test("short text is kept; long text is cut at a word with dots; whitespace is collapsed", () => {
    expect(excerptOf("  Mix   flour\nand\twater.  ")).toBe("Mix flour and water.");
    const long = "word ".repeat(100);
    const cut = excerptOf(long);
    expect(Array.from(cut).length).toBeLessThanOrEqual(156);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toMatch(/word…$/.source === "x" ? /x/ : /wor…$/);
    expect(cut.slice(0, -1).endsWith("word")).toBe(true);
  });
  test("text with no spaces is cut as it is, and counted in characters (Chinese, letters outside the basic plane)", () => {
    const chinese = "你好世界".repeat(60);
    expect(Array.from(excerptOf(chinese)).length).toBe(156);
    const rare = excerptOf("𠮷".repeat(300));
    expect(Array.from(rare)).toHaveLength(156);
    expect(rare).not.toMatch(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
    );
  });
  test("nothing gives nothing", () => {
    expect(excerptOf("")).toBe("");
    expect(excerptOf("   ")).toBe("");
  });
});

describe("the first picture", () => {
  test("its address, with entities read; none when there is none", () => {
    expect(firstImageOf('<p>x</p><img src="/uploads/a.png" alt="A"><img src="/b.png">')).toBe(
      "/uploads/a.png",
    );
    expect(firstImageOf('<img alt="x" src="/u/a.png?x=1&amp;y=2">')).toBe("/u/a.png?x=1&y=2");
    expect(firstImageOf("<p>no picture</p>")).toBeNull();
  });
});

describe("structured data in a script tag (SEO-28, SEO-29)", () => {
  const hostile = [
    "</script><script>window.pwned=1</script>",
    "<!-- comment",
    "a & b < c > d",
    "quote \" and ' and \\ backslash",
    "line" + String.fromCharCode(0x2028) + "separator" + String.fromCharCode(0x2029) + "here",
    "\u0000 control",
  ];
  test("whatever the text, the JSON cannot end the tag and reads back exactly", () => {
    for (const title of hostile) {
      const text = jsonLd({ headline: title });
      expect(text, title).not.toMatch(/[<>&]/);
      expect(text, title).not.toContain(String.fromCharCode(0x2028));
      expect(text, title).not.toContain(String.fromCharCode(0x2029));
      expect(JSON.parse(text), title).toEqual({ headline: title });
    }
  });
  test("the escaped form is what a script tag holds: no closing tag inside", () => {
    const html = `<script type="application/ld+json">${jsonLd({ a: hostile })}</script>`;
    expect(html.match(/<\/script/gi)).toHaveLength(1);
  });
});

describe("structured data for a post and for the site", () => {
  const post = postStructuredData({
    origin: "https://example.com",
    path: "/blog/hello",
    title: "Hello",
    description: "Hi there.",
    image: "/uploads/h.png",
    publishedAt: Date.UTC(2026, 10, 1),
    modifiedAt: Date.UTC(2026, 10, 2),
    authorName: "Anna",
    siteName: "Anna's Garden",
  }) as Record<string, unknown>[];
  test("a BlogPosting with dates, author, picture and publisher, and a breadcrumb", () => {
    expect(post[0]).toMatchObject({
      "@type": "BlogPosting",
      headline: "Hello",
      url: "https://example.com/blog/hello",
      datePublished: "2026-11-01T00:00:00.000Z",
      dateModified: "2026-11-02T00:00:00.000Z",
      author: { "@type": "Person", name: "Anna" },
      image: "https://example.com/uploads/h.png",
      publisher: { name: "Anna's Garden" },
    });
    expect(post[1]).toMatchObject({
      "@type": "BreadcrumbList",
      itemListElement: [
        { position: 1, item: "https://example.com/" },
        { position: 2, name: "Hello", item: "https://example.com/blog/hello" },
      ],
    });
  });
  test("no author and no picture leave those out", () => {
    const bare = postStructuredData({
      origin: "https://e.com",
      path: "/blog/x",
      title: "X",
      description: "",
      image: null,
      publishedAt: 0,
      modifiedAt: 0,
      authorName: "",
      siteName: "S",
    }) as Record<string, unknown>[];
    expect(bare[0]).not.toHaveProperty("author");
    expect(bare[0]).not.toHaveProperty("image");
  });
  test("the site: a WebSite with a search action pointing at the search page", () => {
    expect(
      websiteStructuredData({ origin: "https://example.com", name: "Anna", description: "Plants" }),
    ).toMatchObject({
      "@type": "WebSite",
      url: "https://example.com/",
      potentialAction: {
        "@type": "SearchAction",
        target: "https://example.com/search?q={search_term_string}",
      },
    });
  });
});

describe("feeds", () => {
  const info: FeedInfo = {
    origin: "https://example.com",
    siteName: "Anna & Co",
    description: "Plants <and> pots",
    homePath: "/",
    selfPath: "/feed.xml",
    title: "Anna & Co",
  };
  const item = (over: Partial<FeedItem> = {}): FeedItem => ({
    title: 'Tom & "Jerry" <3',
    path: "/blog/tom-jerry",
    html: '<p>Hi</p><img src="/uploads/a.png" alt="A"><a href="/about">About</a><a href="//cdn.example.com/x">cdn</a>',
    excerpt: "Hi there",
    publishedAt: Date.UTC(2026, 10, 1, 9, 30),
    modifiedAt: Date.UTC(2026, 10, 2, 10, 0),
    authorName: "Anna",
    ...over,
  });

  test("links and pictures in the text get the site's address, except links to other sites", () => {
    expect(
      absolutizeHtml(
        '<img src="/u/a.png"><a href="/x">x</a><a href="//cdn.e.com/y">y</a><a href="https://o.com/z">z</a>',
        "https://example.com/",
      ),
    ).toBe(
      '<img src="https://example.com/u/a.png"><a href="https://example.com/x">x</a><a href="//cdn.e.com/y">y</a><a href="https://o.com/z">z</a>',
    );
  });

  test("RSS: channel, the self link, items with the right dates and the full text; everything escaped", () => {
    const xml = buildRss(info, [
      item(),
      item({ title: "Second", path: "/blog/second", publishedAt: Date.UTC(2026, 9, 1) }),
    ]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<title>Anna &amp; Co</title>");
    expect(xml).toContain("<description>Plants &lt;and&gt; pots</description>");
    expect(xml).toContain(
      '<atom:link href="https://example.com/feed.xml" rel="self" type="application/rss+xml"/>',
    );
    expect(xml).toContain("<title>Tom &amp; &quot;Jerry&quot; &lt;3</title>");
    expect(xml).toContain("<link>https://example.com/blog/tom-jerry</link>");
    expect(xml).toContain("<pubDate>Sun, 01 Nov 2026 09:30:00 GMT</pubDate>");
    expect(xml).toContain("<lastBuildDate>Mon, 02 Nov 2026 10:00:00 GMT</lastBuildDate>");
    expect(xml).toContain("&lt;img src=&quot;https://example.com/uploads/a.png&quot;");
    expect(xml).toContain("<dc:creator>Anna</dc:creator>");
    expect((xml.match(/<item>/g) ?? []).length).toBe(2);
    // The only "&" left start one of the five entities.
    expect(xml.replace(/&(amp|lt|gt|quot|apos);/g, "").includes("&")).toBe(false);
  });

  test("Atom: feed, entries with published and updated times and the full text; everything escaped", () => {
    const xml = buildAtom({ ...info, selfPath: "/atom.xml" }, [item()]);
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain(
      '<link href="https://example.com/atom.xml" rel="self" type="application/atom+xml"/>',
    );
    expect(xml).toContain("<id>https://example.com/blog/tom-jerry</id>");
    expect(xml).toContain("<published>2026-11-01T09:30:00.000Z</published>");
    expect(xml).toContain("<updated>2026-11-02T10:00:00.000Z</updated>");
    expect(xml).toContain('<content type="html">&lt;p&gt;Hi&lt;/p&gt;');
    expect(xml.replace(/&(amp|lt|gt|quot|apos);/g, "").includes("&")).toBe(false);
  });

  test("an empty feed is still a valid file", () => {
    const rss = buildRss(info, []);
    expect(rss).toContain("<channel>");
    expect(rss).not.toContain("<item>");
    expect(rss).not.toContain("lastBuildDate");
    expect(buildAtom(info, [])).toContain("<updated>1970-01-01T00:00:00.000Z</updated>");
  });

  test("a text that tries to end the XML cannot", () => {
    const xml = buildRss(info, [
      item({ title: "]]></title><x>", html: "<p>]]></content:encoded><y/></p>" }),
    ]);
    expect(xml).not.toContain("<x>");
    expect(xml).not.toContain("<y/>");
  });
});

describe("what a person writes in the SEO box", () => {
  test("a description and the noindex switch; trimmed; damaged or too long values mean none", () => {
    expect(readEntrySeo({ description: "  Fresh bread.  ", noindex: true })).toEqual({
      description: "Fresh bread.",
      noindex: true,
    });
    expect(readEntrySeo(JSON.stringify({ description: "x" }))).toEqual({
      description: "x",
      noindex: false,
    });
    for (const bad of [undefined, null, "not json", 5, [], { description: 5, noindex: "yes" }])
      expect(readEntrySeo(bad)).toEqual({ description: "", noindex: false });
    expect(readEntrySeo({ description: "x".repeat(SEO_DESCRIPTION_MAX + 1) }).description).toBe("");
    expect(readEntrySeo({ description: "x".repeat(SEO_DESCRIPTION_MAX) }).description).toHaveLength(
      SEO_DESCRIPTION_MAX,
    );
  });
});
