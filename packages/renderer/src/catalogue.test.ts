// The rest of the block catalogue (spec 06, section 14): gallery, audio, icon, social links, map, accordion, tabs, slider.
// Every block shows its content with JavaScript off (PB-91), draws only safe addresses, and the icon only draws
// shapes of the built-in set (PB-98). Nothing is sent to a map company before a click (PB-93).
import { checkBlocks, type Block } from "@oks-page/content-safety";
import { describe, expect, test } from "vitest";
import { ICON_NAMES, pageCss, writeBlocks } from "./index.js";

let n = 0;
const block = (type: string, over: Partial<Block> = {}): Block => ({
  id: `c${++n}`,
  type,
  props: {},
  content: null,
  children: [],
  ...over,
});
const html = (...blocks: Block[]) => writeBlocks(blocks).html;
const words = (value: string) => [{ type: "text", text: value, styles: {} }];

describe("gallery, audio, icon, social links", () => {
  test("a gallery lists its pictures with descriptions and captions; an unsafe address is dropped", () => {
    const out = html(
      block("gallery", {
        props: {
          columns: 4,
          images: [
            { src: "/uploads/a.jpg", alt: "A <b>", caption: "First" },
            { src: "javascript:alert(1)", alt: "bad" },
          ],
        },
      }),
    );
    expect(out).toBe(
      '<ul class="gallery gallery-4"><li><figure><img src="/uploads/a.jpg" alt="A &lt;b&gt;" loading="lazy"><figcaption>First</figcaption></figure></li></ul>',
    );
    expect(html(block("gallery", { props: { images: [] } }))).toBe("");
  });

  test("an audio player has a link inside it for browsers that cannot play it", () => {
    const out = html(block("audio", { props: { src: "/uploads/talk.mp3", title: "The talk" } }));
    expect(out).toContain('<audio controls preload="none" src="/uploads/talk.mp3">');
    expect(out).toContain('<a href="/uploads/talk.mp3"');
    expect(html(block("audio", { props: { src: "javascript:x" } }))).toBe("");
  });

  test("PB-98: the icon draws only icons from the built-in set", () => {
    for (const name of ICON_NAMES)
      expect(html(block("icon", { props: { name, label: "x" } }))).toContain("<path d=");
    expect(html(block("icon", { props: { name: "<script>" } }))).toBe("");
    expect(html(block("icon", { props: { name: "star" } }))).toContain('aria-hidden="true"');
    const linked = html(
      block("icon", { props: { name: "mail", href: "mailto:a@b.test", label: "Write to us" } }),
    );
    expect(linked).toContain('<a class="icon" href="mailto:a@b.test"');
    expect(linked).toContain('aria-label="Write to us"');
    expect(html(block("icon", { props: { name: "star", size: 9999 } }))).toContain('width="128"');
  });

  test("social links show a plain name for each network", () => {
    const out = html(
      block("socialLinks", {
        props: {
          items: [
            { network: "github", href: "https://github.com/x" },
            { network: "Fediverse", href: "https://example.social/@x" },
            { network: "x", href: "javascript:alert(1)" },
          ],
        },
      }),
    );
    expect(out).toContain(">GitHub</a>");
    expect(out).toContain(">Fediverse</a>");
    expect(out).not.toContain("javascript");
  });
});

describe("a video before a click (PB-93)", () => {
  const src = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  test("nothing in the page asks YouTube for anything: a link, a stored picture, and the name of the company", () => {
    const out = html(
      block("video", { props: { src, caption: "Our <story>", cover: "/uploads/c.jpg" } }),
    );
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<script");
    // The only picture the page loads by itself is the stored one, on this site.
    expect(out).toContain('<img src="/uploads/c.jpg" alt="" loading="lazy">');
    // The link works without script and the words name the company.
    expect(out).toContain('href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"');
    expect(out).toContain("It loads from YouTube.");
    expect(out).toContain("Our &lt;story&gt;");
  });
  test("without a stored picture there is a plain placeholder; a cover from another address is not used", () => {
    expect(html(block("video", { props: { src } }))).not.toContain("<img");
    const other = html(block("video", { props: { src, cover: "https://evil.test/x.jpg" } }));
    expect(other).not.toContain("evil.test");
    expect(html(block("video", { props: { src, cover: "/uploads/../x.jpg" } }))).not.toContain(
      "<img",
    );
  });
  test("the page style has the rules of the video block only when a video is on the page", () => {
    expect(pageCss([block("video", { props: { src } })])).toContain(".video-load{");
    expect(pageCss([block("paragraph")])).not.toContain(".video-load");
  });
});

describe("a map before a click (PB-94)", () => {
  const props = { query: "Greenwich", provider: "osm", cover: "/uploads/map-1.png" };
  test("a stored picture of the place is drawn, with the credit, and the page asks no map company for anything", () => {
    const out = html(block("map", { props }));
    expect(out).toContain('<img src="/uploads/map-1.png" alt="" loading="lazy">');
    expect(out).toContain("&copy; OpenStreetMap contributors");
    expect(out).toContain("Show the map: Greenwich");
    // The only addresses in the block are the link the visitor may follow and the stored picture.
    expect(out.match(/(?:src|href)="[^"]*"/g)).toEqual([
      'href="https://www.openstreetmap.org/search?query=Greenwich"',
      'src="/uploads/map-1.png"',
    ]);
  });
  test("a Google map has no picture, and a cover from another address is not used", () => {
    expect(html(block("map", { props: { ...props, provider: "google" } }))).not.toContain("<img");
    expect(
      html(block("map", { props: { ...props, cover: "https://evil.test/x.png" } })),
    ).not.toContain("<img");
  });
});

describe("map, accordion, tabs, slider", () => {
  test("PB-93: a map is a link until the visitor follows it, and it names the company it opens", () => {
    const out = html(block("map", { props: { query: "10 Rue de Rivoli, Paris" } }));
    expect(out).toContain(
      "https://www.openstreetmap.org/search?query=10%20Rue%20de%20Rivoli%2C%20Paris",
    );
    expect(out).toContain("Opens OpenStreetMap.");
    expect(out).not.toContain("<iframe");
    expect(html(block("map", { props: { query: "Home", provider: "google" } }))).toContain(
      "Opens Google Maps.",
    );
    expect(html(block("map", { props: { query: "  " } }))).toBe("");
  });

  test("PB-91: an accordion is the browser's own open and close, one open at a time when asked", () => {
    const item = (t: string) =>
      block("toggle", {
        content: words(t),
        children: [block("paragraph", { content: words("x") })],
      });
    const many = html(block("accordion", { children: [item("A"), item("B")] }));
    expect(many).toContain('<div class="accordion"><details><summary>A</summary>');
    const single = html(
      block("accordion", { id: "acc1", props: { single: true }, children: [item("A"), item("B")] }),
    );
    expect(single.match(/<details name="a-acc1">/g)).toHaveLength(2);
  });

  test("PB-91: tabs show one under another, each with a heading; slides scroll sideways", () => {
    const tabs = html(
      block("tabs", {
        children: [
          block("tab", {
            props: { title: "One" },
            children: [block("paragraph", { content: words("first") })],
          }),
          block("tab", {
            props: { title: "Two" },
            children: [block("paragraph", { content: words("second") })],
          }),
        ],
      }),
    );
    expect(tabs).toBe(
      '<div class="tabs"><section class="tab"><h3>One</h3><p>first</p></section><section class="tab"><h3>Two</h3><p>second</p></section></div>',
    );
    const slider = html(
      block("slider", {
        props: { label: "News" },
        children: [block("slide", { children: [block("paragraph", { content: words("hi") })] })],
      }),
    );
    expect(slider).toContain(
      'role="region" aria-roledescription="carousel" aria-label="News" tabindex="0"',
    );
    expect(slider).toContain(
      '<div class="slide" role="group" aria-roledescription="slide"><p>hi</p></div>',
    );
  });

  test("the page CSS has the base rules of only the blocks the page uses", () => {
    const css = pageCss([
      block("gallery", { props: { images: [{ src: "/a.jpg" }] } }),
      block("socialLinks"),
    ]);
    expect(css).toContain(".gallery-3{");
    expect(css).toContain(".social-links{");
    expect(css).not.toContain(".slider{");
    expect(pageCss([block("tabs"), block("slider")])).toContain(".slider{display:flex");
  });

  test("their words reach the plain text for search", () => {
    const written = writeBlocks([
      block("gallery", {
        props: { images: [{ src: "/a.jpg", alt: "A red barn", caption: "At dawn" }] },
      }),
      block("map", { props: { query: "Old Mill Road" } }),
      block("tab", { props: { title: "Prices" } }),
    ]);
    expect(written.plainText).toContain("A red barn At dawn");
    expect(written.plainText).toContain("Old Mill Road");
    expect(written.plainText).toContain("Prices");
  });
});

describe("the block checks for these blocks (PB-61)", () => {
  test("unsafe addresses in a gallery, in social links and in an audio block are removed on save", () => {
    const { body, repairs } = checkBlocks({
      version: 1,
      blocks: [
        {
          id: "g",
          type: "gallery",
          props: {
            images: [
              { src: "https://ok.test/a.jpg", alt: "a", extra: "no" },
              { src: "javascript:x" },
              "str",
            ],
          },
          children: [],
        },
        {
          id: "s",
          type: "socialLinks",
          props: { items: [{ network: "x", href: "data:text/html,x" }] },
          children: [],
        },
        { id: "a", type: "audio", props: { src: "javascript:y" }, children: [] },
      ],
    });
    expect(body.blocks[0]!.props["images"]).toEqual([{ src: "https://ok.test/a.jpg", alt: "a" }]);
    expect(body.blocks[1]!.props["items"]).toEqual([]);
    expect(body.blocks[2]!.props["src"]).toBeUndefined();
    expect(repairs).toContain("removed_url");
  });

  test("a gallery of 500 pictures keeps 100", () => {
    const images = Array.from({ length: 500 }, (_, i) => ({ src: `/u/${i}.jpg` }));
    const { body } = checkBlocks({
      version: 1,
      blocks: [{ id: "g", type: "gallery", props: { images }, children: [] }],
    });
    expect((body.blocks[0]!.props["images"] as unknown[]).length).toBe(100);
  });
});

describe("ids for the editor's preview", () => {
  test("only when asked, on the first element of each block, and only a safe id", () => {
    const blocks = [
      block("paragraph", { id: "p-1", content: words("x") }),
      block("divider", { id: 'bad"id' }),
    ];
    expect(writeBlocks(blocks).html).toBe("<p>x</p><hr>");
    expect(writeBlocks(blocks, { ids: true }).html).toBe('<p data-oks-id="p-1">x</p><hr>');
  });
});
