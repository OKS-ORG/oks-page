import { DEFAULT_ROLES } from "@oks-page/core";
import { describe, expect, test } from "vitest";
import { navFor } from "./admin-nav";

const keysOf = (role: string) => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return navFor((c) => caps.includes(c)).map((i) => i.key);
};

describe("the menu for each default role", () => {
  test("administrator sees everything", () => {
    expect(keysOf("administrator")).toEqual([
      "home",
      "pages",
      "posts",
      "content",
      "comments",
      "taxonomies",
      "menus",
      "media",
      "users",
      "tools",
      "plugins",
      "publish",
      "statistics",
      "handoff",
      "collect",
      "connector",
      "agency",
      "privacy-requests",
      "settings",
    ]);
  });
  test("editor manages categories and tags but has no settings", () => {
    expect(keysOf("editor")).toEqual([
      "home",
      "pages",
      "posts",
      "content",
      "comments",
      "taxonomies",
      "menus",
      "media",
    ]);
  });
  test("author writes and uploads, but has no settings", () => {
    expect(keysOf("author")).toEqual(["home", "pages", "posts", "media"]);
  });
  test("contributor writes but has no library and no settings", () => {
    expect(keysOf("contributor")).toEqual(["home", "pages", "posts"]);
  });
  test("the client (spec 11, section 4) sees Home, Pages, Posts and Media, and nothing about the site's structure or settings", () => {
    expect(keysOf("client")).toEqual(["home", "pages", "posts", "media"]);
  });
  test("subscriber only has Home", () => {
    expect(keysOf("subscriber")).toEqual(["home"]);
  });
  test("a person with no capabilities only has Home", () => {
    expect(navFor(() => false).map((i) => i.key)).toEqual(["home"]);
  });
});

describe("the menu has no repeats", () => {
  test("every entry has its own key and its own address (an administrator sees them all)", () => {
    const caps = DEFAULT_ROLES.find((r) => r.key === "administrator")!.capabilities;
    const items = navFor((c) => caps.includes(c));
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.href)).size).toBe(items.length);
  });
});
