// What a plugin says about its cookies and the other companies it calls (spec 18, section 2): what a manifest may say,
// which declarations need consent, and that a plugin file carries them and refuses broken ones.
import { describe, expect, test } from "vitest";
import { needsConsent, readCookies, readOutsideHosts } from "./consent.js";
import { makePluginFile, readPluginFile } from "./plugin-file.js";

const cookie = (over: Record<string, unknown> = {}) => ({
  name: "demo_visit",
  purpose: "statistics",
  why: "Counts how many people come back.",
  keptFor: "30 days",
  ...over,
});
const host = (over: Record<string, unknown> = {}) => ({
  host: "maps.example.com",
  purpose: "media",
  why: "Shows the map.",
  ...over,
});

describe("what a manifest may say about cookies and outside addresses", () => {
  test("a good list is read as it is", () => {
    expect(readCookies([cookie()])).toEqual([cookie()]);
    expect(readOutsideHosts([host()])).toEqual([host()]);
    expect(readCookies([])).toEqual([]);
  });

  test.each([
    ["not a list", "x"],
    ["no name", [cookie({ name: undefined })]],
    ["a name with spaces", [cookie({ name: "a b" })]],
    ["a purpose that is not known", [cookie({ purpose: "tracking" })]],
    ["no reason", [cookie({ why: " " })]],
    ["a reason that is too long", [cookie({ why: "x".repeat(201) })]],
    ["a keeping time that is too long", [cookie({ keptFor: "x".repeat(41) })]],
    ["the same name twice", [cookie(), cookie()]],
    ["too many", Array.from({ length: 11 }, (_, i) => cookie({ name: `c${i}` }))],
  ])("cookies: %s is refused in plain words", (_name, value) => {
    expect(typeof readCookies(value)).toBe("string");
  });

  test.each([
    ["not a list", {}],
    ["an address with a path", [host({ host: "example.com/map" })]],
    ["an address in capitals", [host({ host: "Maps.Example.com" })]],
    ["a name with no dot", [host({ host: "localhost" })]],
    ["a purpose that is not known", [host({ purpose: "ads" })]],
    ["no reason", [host({ why: "" })]],
    ["the same address twice", [host(), host()]],
  ])("outside addresses: %s is refused in plain words", (_name, value) => {
    expect(typeof readOutsideHosts(value)).toBe("string");
  });

  test("only essential declarations need no consent", () => {
    const none = { cookies: [], hosts: [] };
    expect(needsConsent(none.cookies, none.hosts)).toBe(false);
    const essentialCookie = readCookies([cookie({ purpose: "essential" })]) as never[];
    const essentialHost = readOutsideHosts([host({ purpose: "essential" })]) as never[];
    expect(needsConsent(essentialCookie, essentialHost)).toBe(false);
    expect(needsConsent(readCookies([cookie()]) as never[], essentialHost)).toBe(true);
    expect(needsConsent(essentialCookie, readOutsideHosts([host()]) as never[])).toBe(true);
  });
});

describe("a plugin file with these declarations", () => {
  const manifest = {
    id: "consent-demo",
    version: "1.0.0",
    displayName: "Consent demo",
    description: "d",
    author: "a",
    permissions: [],
    hooks: [],
    blocks: [],
  };

  test("carries them, and refuses a broken one", () => {
    const ok = readPluginFile(
      JSON.stringify(
        makePluginFile(
          {
            ...manifest,
            cookies: readCookies([cookie()]) as never,
            outsideHosts: readOutsideHosts([host()]) as never,
          },
          "export default {};",
        ),
      ),
    );
    expect(ok.ok && ok.file.manifest.cookies?.[0]?.name).toBe("demo_visit");
    expect(ok.ok && ok.file.manifest.outsideHosts?.[0]?.host).toBe("maps.example.com");
    for (const bad of [{ cookies: [{ name: "x" }] }, { outsideHosts: [{ host: "nodot" }] }]) {
      const r = readPluginFile(
        JSON.stringify(makePluginFile({ ...manifest, ...bad } as never, "export default {};")),
      );
      expect(r.ok).toBe(false);
    }
  });
});
