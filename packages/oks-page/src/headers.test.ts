// The header contract as pure functions (decision D81).
import { describe, expect, test } from "vitest";
import {
  notFoundHeaders,
  pageHeaders,
  PRIVATE,
  PUBLIC_NOT_FOUND,
  PUBLIC_PAGE,
  visitorOf,
} from "./headers";

describe("visitorOf", () => {
  test("no cookies is anonymous", () => expect(visitorOf([])).toBe("anonymous"));
  test("other cookies do not change that", () =>
    expect(visitorOf(["theme", "lang"])).toBe("anonymous"));
  test("a session cookie, with or without the secure prefix, is signed in", () => {
    expect(visitorOf(["better-auth.session_token"])).toBe("signed-in");
    expect(visitorOf(["__Secure-better-auth.session_token"])).toBe("signed-in");
  });
  test("Draft Mode and preview cookies are previews, even with a session", () => {
    expect(visitorOf(["__prerender_bypass"])).toBe("preview");
    expect(visitorOf(["__next_preview_data", "better-auth.session_token"])).toBe("preview");
  });
});

describe("pageHeaders", () => {
  const tags = ["site:S", "entry:E", "type:page"];
  test("CDN off, anonymous: nothing changes (Next.js sends its own private headers)", () =>
    expect(pageHeaders({ cdn: false, visitor: "anonymous", tags })).toEqual({}));
  test("CDN on, anonymous: public with a tag list", () =>
    expect(pageHeaders({ cdn: true, visitor: "anonymous", tags })).toEqual({
      "cache-control": PUBLIC_PAGE,
      "cache-tag": "site:S,entry:E,type:page",
    }));
  test("signed-in and preview are always private and carry no tags, CDN on or off", () => {
    for (const cdn of [true, false])
      for (const visitor of ["signed-in", "preview"] as const)
        expect(pageHeaders({ cdn, visitor, tags })).toEqual({ "cache-control": PRIVATE });
  });
});

describe("notFoundHeaders", () => {
  test("CDN on, anonymous: a short public cache", () =>
    expect(notFoundHeaders({ cdn: true, visitor: "anonymous" })).toEqual({
      "cache-control": PUBLIC_NOT_FOUND,
    }));
  test("CDN off: nothing changes", () =>
    expect(notFoundHeaders({ cdn: false, visitor: "anonymous" })).toEqual({}));
  test("signed-in is private", () =>
    expect(notFoundHeaders({ cdn: true, visitor: "signed-in" })).toEqual({
      "cache-control": PRIVATE,
    }));
});
