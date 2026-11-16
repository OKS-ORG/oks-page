import { describe, expect, test } from "vitest";
import { publishProblems } from "./publish-check.js";

const para = (text: string) => ({
  id: `p${Math.random().toString(36).slice(2, 8)}`,
  type: "paragraph",
  props: {},
  content: text === "" ? [] : [{ type: "text", text, styles: {} }],
  children: [],
});
const image = (alt: string, extra: Record<string, unknown> = {}) => ({
  id: `i${Math.random().toString(36).slice(2, 8)}`,
  type: "image",
  props: { src: "/uploads/a.png", alt, ...extra },
  content: null,
  children: [],
});
const rules = (title: string, blocks: unknown[]) =>
  publishProblems(title, blocks).map((p) => p.rule);

describe("the publish check (spec 03, section 8, point 5)", () => {
  test("a page with a title, some words and described pictures has no problems", () => {
    expect(rules("Hello", [para("Words."), image("A cat")])).toEqual([]);
  });

  test("a missing title and an empty body are found", () => {
    expect(rules("  ", [para("Words.")])).toEqual(["missing-title"]);
    expect(rules("Hello", [])).toEqual(["empty-body"]);
    expect(rules("Hello", [para(""), para("   ")])).toEqual(["empty-body"]);
    expect(rules("", [])).toEqual(["missing-title", "empty-body"]);
  });

  test("a picture alone is content; a divider alone is not", () => {
    expect(rules("Hello", [image("A cat")])).toEqual([]);
    expect(
      rules("Hello", [{ id: "d1", type: "divider", props: {}, content: null, children: [] }]),
    ).toEqual(["empty-body"]);
  });

  test("each picture without a description is named by its number; a decorative one is left out", () => {
    const found = publishProblems("Hello", [
      para("Words."),
      image("A cat"),
      image(""),
      image("  "),
      image("", { decorative: true }),
    ]);
    expect(found.map((p) => p.rule)).toEqual(["missing-alt", "missing-alt"]);
    expect(found[0]!.message).toMatch(/^Picture 2 has no description/);
    expect(found[1]!.message).toMatch(/^Picture 3 has no description/);
  });

  test("advice about style never blocks: a skipped heading and a vague link are not problems here", () => {
    expect(
      rules("Hello", [
        {
          id: "h1",
          type: "heading",
          props: { level: 4 },
          content: [{ type: "text", text: "A", styles: {} }],
          children: [],
        },
        {
          id: "p1",
          type: "paragraph",
          props: {},
          content: [{ type: "link", href: "https://example.org/", text: "click here" }],
          children: [],
        },
      ]),
    ).toEqual([]);
  });

  test("anything that is not a list of blocks is empty, not a crash", () => {
    expect(rules("Hello", [])).toEqual(["empty-body"]);
    expect(publishProblems("Hello", "nonsense").map((p) => p.rule)).toEqual(["empty-body"]);
    expect(publishProblems("Hello", null).map((p) => p.rule)).toEqual(["empty-body"]);
  });
});
