import { describe, expect, test } from "vitest";
import { pageCount, pagePath, pagingOf } from "./paging";

describe("addresses of the later pages of a list", () => {
  test("the list and the page number are read from the end of the address", () => {
    expect(pagingOf("page/2")).toEqual({ base: "home", page: 2 });
    expect(pagingOf("blog/page/12")).toEqual({ base: "blog", page: 12 });
    expect(pagingOf("category/news/page/3")).toEqual({ base: "category/news", page: 3 });
    expect(pagingOf("tag/a-b/page/999999")).toEqual({ base: "tag/a-b", page: 999999 });
    expect(pagingOf("page/1")).toEqual({ base: "home", page: 1 });
  });
  test("anything else is not a page of a list", () => {
    for (const slug of [
      "home",
      "about",
      "page",
      "page/",
      "page/0",
      "page/02",
      "page/-1",
      "page/+2",
      "page/2.5",
      "page/1000000",
      "page/x",
      "blog/page/2/extra",
      "blog/pages/2",
      "category/news/page",
    ])
      expect(pagingOf(slug), slug).toBeNull();
  });
  test("a page's address, and page 1 is the list itself", () => {
    expect(pagePath("home", 1)).toBe("/");
    expect(pagePath("home", 2)).toBe("/page/2");
    expect(pagePath("blog", 1)).toBe("/blog");
    expect(pagePath("blog", 3)).toBe("/blog/page/3");
    expect(pagePath("category/news", 2)).toBe("/category/news/page/2");
  });
  test("how many pages: at least one", () => {
    expect(pageCount(0, 10)).toBe(1);
    expect(pageCount(10, 10)).toBe(1);
    expect(pageCount(11, 10)).toBe(2);
    expect(pageCount(25, 10)).toBe(3);
    expect(pageCount(5, 0)).toBe(5);
  });
});
