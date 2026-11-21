// The packages are ready to be published: what npm needs is in each package.json, and they can be published in an order
// where every package comes after the ones it needs.
import { describe, expect, test } from "vitest";
import { inOrder, packages } from "./release.mjs";

const list = packages();

describe("the packages are ready to publish", () => {
  test("every package is public, has a licence, a repository, the same version and says what it publishes", () => {
    expect(list.length).toBeGreaterThanOrEqual(15);
    const versions = new Set(list.map((p) => p.json.version));
    expect(versions.size, [...versions].join(", ")).toBe(1);
    for (const { json } of list) {
      expect(json.private, json.name).toBeUndefined();
      expect(json.license, json.name).toBe("MIT");
      expect(json.repository?.url, json.name).toContain("github.com/OKS-ORG/oks-page");
      expect(json.publishConfig, json.name).toEqual({ access: "public" });
      expect(json.files, json.name).toContain("dist");
      expect(json.engines, json.name).toEqual({ node: ">=22" });
    }
  });

  test("the order puts every package after the packages it needs, without a circle", () => {
    const order = inOrder(list).map((p) => p.json.name);
    expect(new Set(order).size).toBe(list.length);
    for (const pkg of list) {
      for (const dep of Object.keys(pkg.json.dependencies ?? {})) {
        if (order.includes(dep)) {
          expect(order.indexOf(dep), `${dep} before ${pkg.json.name}`).toBeLessThan(
            order.indexOf(pkg.json.name),
          );
        }
      }
    }
  });

  test("packages of this product link to each other with workspace:* (the publish step writes the version)", () => {
    const names = new Set(list.map((p) => p.json.name));
    for (const { json } of list) {
      for (const [dep, range] of Object.entries(json.dependencies ?? {})) {
        if (names.has(dep)) expect(range, `${json.name} -> ${dep}`).toBe("workspace:*");
      }
    }
  });
});
