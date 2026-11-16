import { describe, expect, test } from "vitest";
import { checkAccessibility, LONG_PARAGRAPH_WORDS, type CheckedBlock } from "./accessibility";

let n = 0;
const block = (
  type: string,
  props: Record<string, unknown> = {},
  content: unknown = [],
  children: CheckedBlock[] = [],
): CheckedBlock => ({ id: `b${++n}`, type, props, content, children });
const words = (text: string) => [{ type: "text", text, styles: {} }];
const link = (text: string, href = "https://example.org/") => [{ type: "link", href, text }];
const rules = (blocks: CheckedBlock[]) => checkAccessibility(blocks).map((i) => i.rule);

describe("the accessibility checker (EC-41)", () => {
  test("a clean page has nothing to report", () => {
    expect(
      checkAccessibility([
        block("heading", { level: 2 }, words("Hours")),
        block("paragraph", {}, words("Open daily.")),
        block("image", { src: "/uploads/a.png", alt: "The shop front" }),
        block("heading", { level: 3 }, words("Holidays")),
        block("paragraph", {}, link("Read the holiday opening hours")),
      ]),
    ).toEqual([]);
  });

  test("a picture with no description is found; a decorative one is not", () => {
    const found = checkAccessibility([
      block("image", { src: "/uploads/a.png", alt: "" }),
      block("image", { src: "/uploads/b.png", alt: "  " }),
      block("image", { src: "/uploads/c.png", alt: "", decorative: true }),
      block("image", { src: "/uploads/d.png", alt: "A cat" }),
    ]);
    expect(found.map((i) => [i.rule, i.where])).toEqual([
      ["missing-alt", "Picture 1"],
      ["missing-alt", "Picture 2"],
    ]);
    expect(found[0]!.message).toMatch(/no description/);
  });

  test("a heading that skips a level is found, and the first heading is not judged", () => {
    expect(
      rules([
        block("heading", { level: 3 }, words("Starts low")),
        block("heading", { level: 4 }, words("Fine")),
        block("heading", { level: 2 }, words("Back up is fine")),
        block("heading", { level: 5 }, words("Jumps")),
      ]),
    ).toEqual(["skipped-heading"]);
    const [one] = checkAccessibility([
      block("heading", { level: 2 }, words("A")),
      block("heading", { level: 4 }, words("B")),
    ]);
    expect(one!.message).toMatch(/jumps from level 2 to level 4. Use level 3/);
  });

  test("an empty link and a vague link are found, in any block and in table cells", () => {
    expect(
      rules([
        block("paragraph", {}, link("")),
        block("paragraph", {}, link("Click here.")),
        block("paragraph", {}, link("READ MORE")),
        block("bulletList", {}, link("here")),
        block("paragraph", {}, link("Our returns policy")),
        block(
          "table",
          { headerRow: true },
          { rows: [{ cells: [link("click here"), words("x")] }] },
        ),
      ]),
    ).toEqual(["empty-link", "vague-link", "vague-link", "vague-link", "vague-link"]);
  });

  test("a table with several rows and no header row is found", () => {
    const cells = (a: string, b: string) => ({ cells: [words(a), words(b)] });
    expect(rules([block("table", {}, { rows: [cells("a", "b"), cells("c", "d")] })])).toEqual([
      "table-header",
    ]);
    expect(
      rules([block("table", { headerRow: true }, { rows: [cells("a", "b"), cells("c", "d")] })]),
    ).toEqual([]);
    expect(rules([block("table", {}, { rows: [cells("a", "b")] })])).toEqual([]);
  });

  test("text whose color and background are too close is found", () => {
    const run = (color: string, backgroundColor: string) => [
      { type: "text", text: "Sale", styles: { color, backgroundColor } },
    ];
    const found = checkAccessibility([
      block("paragraph", {}, run("#999999", "#ffffff")),
      block("paragraph", {}, run("#000000", "#ffffff")),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: "low-contrast", where: "Paragraph 1" });
    expect(found[0]!.message).toMatch(/contrast of 2\.8 to 1/);
  });

  test("a very long paragraph is found", () => {
    const long = Array.from({ length: LONG_PARAGRAPH_WORDS + 1 }, () => "word").join(" ");
    const short = Array.from({ length: LONG_PARAGRAPH_WORDS }, () => "word").join(" ");
    expect(
      rules([block("paragraph", {}, words(long)), block("paragraph", {}, words(short))]),
    ).toEqual(["long-paragraph"]);
  });

  test("blocks inside other blocks are read, in the order of the page, and each issue names its block", () => {
    const inner = block("image", { alt: "" });
    const found = checkAccessibility([
      block("paragraph", {}, link("here")),
      block("columns", {}, [], [block("heading", { level: 2 }, words("H"), [inner])]),
    ]);
    expect(found.map((i) => i.rule)).toEqual(["vague-link", "missing-alt"]);
    expect(found[1]!.blockId).toBe(inner.id);
    expect(found[1]!.where).toBe("Picture 1");
  });
});
