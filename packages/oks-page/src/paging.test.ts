import { describe, expect, test } from "vitest";
import { pageCount, pageNumbers, pagePath, pagingOf } from "./paging";

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

describe("the numbers under a list", () => {
  test("a short list shows every number", () => {
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(2, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageNumbers(1, 6)).toEqual([1, 2, 3, "gap", 6]);
  });
  test("a long list shows the first, the last and the pages near the current one", () => {
    expect(pageNumbers(1, 20)).toEqual([1, 2, 3, "gap", 20]);
    expect(pageNumbers(10, 20)).toEqual([1, "gap", 8, 9, 10, 11, 12, "gap", 20]);
    expect(pageNumbers(20, 20)).toEqual([1, "gap", 18, 19, 20]);
    expect(pageNumbers(999999, 999999)).toEqual([1, "gap", 999997, 999998, 999999]);
  });
  test("a hole of one page is filled, not shown as a gap", () => {
    expect(pageNumbers(5, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(pageNumbers(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageNumbers(7, 12)).toEqual([1, "gap", 5, 6, 7, 8, 9, "gap", 12]);
  });
  test("the current page is always in, and no number repeats", () => {
    for (let pages = 1; pages <= 30; pages++)
      for (let page = 1; page <= pages; page++) {
        const out = pageNumbers(page, pages);
        const numbers = out.filter((n): n is number => n !== "gap");
        expect(numbers).toContain(page);
        expect(new Set(numbers).size).toBe(numbers.length);
        expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
        expect(numbers[0]).toBe(1);
        expect(numbers.at(-1)).toBe(pages);
      }
  });
});
