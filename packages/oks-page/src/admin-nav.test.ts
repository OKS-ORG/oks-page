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
      "taxonomies",
      "media",
      "settings",
    ]);
  });
  test("editor manages categories and tags but has no settings", () => {
    expect(keysOf("editor")).toEqual(["home", "pages", "posts", "taxonomies", "media"]);
  });
  test("author writes and uploads, but has no settings", () => {
    expect(keysOf("author")).toEqual(["home", "pages", "posts", "media"]);
  });
  test("contributor writes but has no library and no settings", () => {
    expect(keysOf("contributor")).toEqual(["home", "pages", "posts"]);
  });
  test("subscriber only has Home", () => {
    expect(keysOf("subscriber")).toEqual(["home"]);
  });
  test("a person with no capabilities only has Home", () => {
    expect(navFor(() => false).map((i) => i.key)).toEqual(["home"]);
  });
});
