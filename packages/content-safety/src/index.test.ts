// Spec 03, section 10 (EC-01 to EC-26: a throw-away model of these rules was tested 21 October
// 2026; this is the real, built version of that model).
import { expect, test } from "vitest";
import { checkBlocks } from "./index.js";

function block(overrides: Record<string, unknown> = {}) {
  return { id: "a1", type: "paragraph", props: {}, content: null, children: [], ...overrides };
}

test("EC-01 a normal paragraph passes unchanged, with no repair messages", () => {
  const input = { version: 1, blocks: [block()] };
  const { body, repairs } = checkBlocks(input);
  expect(repairs).toEqual([]);
  expect(body.blocks).toEqual([block()]);
});

test("EC-02 a text color with an injected attribute is removed", () => {
  const input = {
    blocks: [block({ type: "callout", props: { color: 'red" onmouseover="alert(1)' } })],
  };
  const { body, repairs } = checkBlocks(input);
  expect(body.blocks[0]!.props.color).toBeUndefined();
  expect(repairs).toContain("removed_color");
});

test("EC-03 valid colors (hex, rgb(), names) are kept", () => {
  for (const color of ["#fff", "#112233", "rgb(1, 2, 3)", "rgba(1, 2, 3, 0.5)", "red"]) {
    const { body, repairs } = checkBlocks({
      blocks: [block({ type: "callout", props: { color } })],
    });
    expect(body.blocks[0]!.props.color).toBe(color);
    expect(repairs).toEqual([]);
  }
});

test("EC-04 url(), expression() and 'red;}' as colors are removed", () => {
  for (const color of ["url(x.png)", "expression(alert(1))", "red;}"]) {
    const { body, repairs } = checkBlocks({
      blocks: [block({ type: "callout", props: { color } })],
    });
    expect(body.blocks[0]!.props.color).toBeUndefined();
    expect(repairs).toContain("removed_color");
  }
});

test("EC-05 a javascript: link becomes plain text", () => {
  const input = {
    blocks: [
      block({
        content: [
          { type: "link", href: "javascript:alert(1)", content: [{ type: "text", text: "click" }] },
        ],
      }),
    ],
  };
  const { body, repairs } = checkBlocks(input);
  expect(body.blocks[0]!.content).toEqual([{ type: "text", text: "click" }]);
  expect(repairs).toContain("removed_link");
});

test("EC-06 https, http, mailto, tel and relative links are kept", () => {
  for (const href of [
    "https://example.com",
    "http://example.com",
    "mailto:a@example.com",
    "tel:+1234567890",
    "/about",
    "#top",
    "?x=1",
  ]) {
    const { body, repairs } = checkBlocks({
      blocks: [block({ content: [{ type: "link", href, content: [] }] })],
    });
    expect(body.blocks[0]!.content).toEqual([{ type: "link", href, content: [] }]);
    expect(repairs).not.toContain("removed_link");
  }
});

test("EC-07 tricky addresses are refused", () => {
  for (const href of [
    "//evil.com",
    "\\\\evil.com",
    "data:text/html,x",
    "vbscript:alert(1)",
    "jAvAsCrIpT:alert(1)",
    " javascript:alert(1)",
    "java\nscript:alert(1)",
  ]) {
    const { body, repairs } = checkBlocks({
      blocks: [block({ content: [{ type: "link", href, content: [] }] })],
    });
    expect(body.blocks[0]!.content).toEqual([]);
    expect(repairs).toContain("removed_link");
  }
});

test("EC-08 a video with a javascript: source loses the source", () => {
  const { body, repairs } = checkBlocks({
    blocks: [block({ type: "video", props: { src: "javascript:alert(1)" } })],
  });
  expect(body.blocks[0]!.props.src).toBeUndefined();
  expect(repairs).toContain("removed_url");
});

test("EC-09 video is kept only from allowed hosts over https", () => {
  const ok = checkBlocks({
    blocks: [block({ type: "video", props: { src: "https://www.youtube.com/watch?v=x" } })],
  });
  expect(ok.body.blocks[0]!.props.src).toBe("https://www.youtube.com/watch?v=x");

  for (const src of ["http://www.youtube.com/watch?v=x", "https://evil.com/video.mp4"]) {
    const { body, repairs } = checkBlocks({ blocks: [block({ type: "video", props: { src } })] });
    expect(body.blocks[0]!.props.src).toBeUndefined();
    expect(repairs).toContain("removed_url");
  }
});

test("EC-10 an embed with a javascript: URL loses it", () => {
  const { body, repairs } = checkBlocks({
    blocks: [block({ type: "embed", props: { url: "javascript:alert(1)" } })],
  });
  expect(body.blocks[0]!.props.url).toBeUndefined();
  expect(repairs).toContain("removed_url");
});

test("EC-11 image src with javascript: or data: is removed; https is kept", () => {
  const bad1 = checkBlocks({
    blocks: [block({ type: "image", props: { src: "javascript:alert(1)" } })],
  });
  expect(bad1.body.blocks[0]!.props.src).toBeUndefined();
  const bad2 = checkBlocks({ blocks: [block({ type: "image", props: { src: "data:,x" } })] });
  expect(bad2.body.blocks[0]!.props.src).toBeUndefined();
  const good = checkBlocks({
    blocks: [block({ type: "image", props: { src: "https://example.com/a.png" } })],
  });
  expect(good.body.blocks[0]!.props.src).toBe("https://example.com/a.png");
});

test("EC-12 an image with a relative media URL is kept", () => {
  const { body, repairs } = checkBlocks({
    blocks: [block({ type: "image", props: { src: "/media/a.png" } })],
  });
  expect(body.blocks[0]!.props.src).toBe("/media/a.png");
  expect(repairs).toEqual([]);
});

test("EC-13 duplicate IDs are made unique, with one message", () => {
  const { body, repairs } = checkBlocks({
    blocks: [block({ id: "dup" }), block({ id: "dup" })],
  });
  expect(body.blocks[0]!.id).toBe("dup");
  expect(body.blocks[1]!.id).not.toBe("dup");
  expect(repairs.filter((r) => r === "made_id_unique")).toHaveLength(1);
});

test("EC-14 missing id, props and children are filled in", () => {
  const { body, repairs } = checkBlocks({ blocks: [{ type: "paragraph" }] });
  expect(body.blocks[0]!.id).toMatch(/^[A-Za-z0-9]+$/);
  expect(body.blocks[0]!.props).toEqual({});
  expect(body.blocks[0]!.children).toEqual([]);
  expect(repairs).toContain("filled_missing_fields");
});

test("EC-15 unknown block types are kept with their props", () => {
  const { body, repairs } = checkBlocks({
    blocks: [block({ type: "forms-contact-form", props: { label: "Send" } })],
  });
  expect(body.blocks[0]!.type).toBe("forms-contact-form");
  expect(body.blocks[0]!.props.label).toBe("Send");
  expect(repairs).toEqual([]);
});

test("EC-16 unknown block types lose strings that look like script addresses, at any depth", () => {
  const { body, repairs } = checkBlocks({
    blocks: [
      block({
        type: "forms-contact-form",
        props: { nested: { url: "javascript:alert(1)" }, list: ["data:text/html,x"] },
      }),
    ],
  });
  expect((body.blocks[0]!.props.nested as Record<string, unknown>).url).toBe("");
  expect((body.blocks[0]!.props.list as unknown[])[0]).toBe("");
  expect(repairs).toContain("stripped_script_url");
});

test("EC-17 invalid type names remove the block", () => {
  for (const type of ["", "has space", "has/slash", "has..dots", "9startsdigit", "a".repeat(65)]) {
    const { body, repairs } = checkBlocks({ blocks: [block({ type })] });
    expect(body.blocks).toEqual([]);
    expect(repairs).toContain("removed_invalid_block");
  }
});

test("EC-17b the editor's own names with capital letters (lists, code) are kept; a made-up name with capitals is not a block", () => {
  const runs = [{ type: "text", text: "item", styles: {} }];
  const types = ["bulletList", "numberedList", "taskList", "codeBlock"];
  const kept = checkBlocks({
    blocks: types.map((type, i) => block({ id: `b${i}`, type, content: runs })),
  });
  expect(kept.repairs).toEqual([]);
  expect(kept.body.blocks.map((b) => b.type)).toEqual(types);
  const refused = checkBlocks({ blocks: [block({ type: "MyOwnBlock" })] });
  expect(refused.body.blocks).toEqual([]);
  expect(refused.repairs).toContain("removed_invalid_block");
});

test("EC-18 props with functions or NaN are replaced by {}", () => {
  const withFn = checkBlocks({
    blocks: [block({ props: { onClick: () => {} } })],
  });
  expect(withFn.body.blocks[0]!.props).toEqual({});
  expect(withFn.repairs).toContain("cleared_props");

  const withNaN = checkBlocks({ blocks: [block({ props: { n: NaN } })] });
  expect(withNaN.body.blocks[0]!.props).toEqual({});
  expect(withNaN.repairs).toContain("cleared_props");
});

test("EC-19 prototype-pollution keys are refused and Object.prototype stays clean", () => {
  // Two shapes of the same attack: an object literal with __proto__ sets the real prototype,
  // while JSON.parse (how data actually arrives from a client) makes it an own key instead.
  const literal = { blocks: [block({ props: { __proto__: { polluted: true } } })] };
  const r1 = checkBlocks(literal);
  expect(r1.body.blocks[0]!.props).toEqual({});
  expect(r1.repairs).toContain("cleared_props");

  const parsed = JSON.parse(
    '{"blocks":[{"id":"a1","type":"paragraph","props":{"__proto__":{"polluted":true}}}]}',
  );
  const r2 = checkBlocks(parsed);
  expect(r2.body.blocks[0]!.props).toEqual({});
  expect(r2.repairs).toContain("cleared_props");

  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test("EC-20 nesting beyond 12 levels is cut, with a message", () => {
  let deepest = block({ id: "leaf" });
  for (let i = 0; i < 14; i++) deepest = block({ id: `b${i}`, children: [deepest] });
  const { body, repairs } = checkBlocks({ blocks: [deepest] });
  let depth = 0;
  let node = body.blocks[0];
  while (node && node.children.length > 0) {
    depth++;
    node = node.children[0];
  }
  expect(depth).toBeLessThanOrEqual(12);
  expect(repairs).toContain("cut_depth");
});

test("EC-21 more than 5,000 blocks are cut", () => {
  const blocks = Array.from({ length: 5010 }, (_, i) => block({ id: `b${i}` }));
  const { body, repairs } = checkBlocks({ blocks });
  expect(body.blocks).toHaveLength(5000);
  expect(repairs).toContain("cut_block_count");
});

test("EC-22 a body that is not a list gives an empty body, not a crash", () => {
  for (const input of [null, undefined, "x", 1, {}, { blocks: "x" }, { blocks: {} }]) {
    const { body, repairs } = checkBlocks(input);
    expect(body.blocks).toEqual([]);
    expect(repairs).toContain("not_a_list");
  }
});

test("EC-23 null and non-object blocks are dropped", () => {
  const { body, repairs } = checkBlocks({ blocks: [null, 1, "x", true, block()] });
  expect(body.blocks).toHaveLength(1);
  expect(repairs.filter((r) => r === "removed_invalid_block")).toHaveLength(4);
});

test("EC-24 text such as <script> stays text", () => {
  const input = {
    blocks: [block({ content: [{ type: "text", text: "<script>alert(1)</script>" }] })],
  };
  const { body } = checkBlocks(input);
  expect((body.blocks[0]!.content as { text: string }[])[0]!.text).toBe(
    "<script>alert(1)</script>",
  );
});

test("EC-25 per-screen style objects (props.style) are kept", () => {
  const style = { base: { "font-size": "16px" }, tablet: { "font-size": "20px" } };
  const { body, repairs } = checkBlocks({ blocks: [block({ props: { style } })] });
  expect(body.blocks[0]!.props.style).toEqual(style);
  expect(repairs).toEqual([]);
});

test("EC-26 checking the result of a check gives the same result (repeatable)", () => {
  const input = {
    blocks: [
      block({
        id: "x",
        type: "image",
        props: { src: "https://example.com/a.png", color: "red" },
        content: [{ type: "text", text: "caption", styles: { bold: true } }],
      }),
    ],
  };
  const first = checkBlocks(input);
  const second = checkBlocks(first.body);
  expect(second.body).toEqual(first.body);
  expect(second.repairs).toEqual([]);
});

test("direction controls: embeddings and overrides are removed, markers are kept", () => {
  const text = "invoice‮gpj.exe";
  const { body, repairs } = checkBlocks({ blocks: [block({ content: [{ type: "text", text }] })] });
  expect((body.blocks[0]!.content as { text: string }[])[0]!.text).toBe("invoicegpj.exe");
  expect(repairs).toContain("stripped_direction_controls");

  const withMarker = "a‎b";
  const kept = checkBlocks({
    blocks: [block({ content: [{ type: "text", text: withMarker }] })],
  });
  expect((kept.body.blocks[0]!.content as { text: string }[])[0]!.text).toBe(withMarker);
});

test("direction controls: an unclosed isolate is removed", () => {
  const text = "a⁦b"; // opened, never closed
  const { body } = checkBlocks({ blocks: [block({ content: [{ type: "text", text }] })] });
  expect((body.blocks[0]!.content as { text: string }[])[0]!.text).toBe("ab");
});
