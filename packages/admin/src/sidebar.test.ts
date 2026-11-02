// The two-level side menu with the icon rail and the Tools group (spec 07 section 3a, D110, D143), in a real browser.
import axe from "axe-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { browserPath, startTestSite, type TestSite } from "./testing/browser-page.js";

const ENTRY = `
const params = new URLSearchParams(location.search);
const dir = params.get("dir") === "rtl" ? "rtl" : "ltr";
document.documentElement.setAttribute("dir", dir);
const tools = params.get("tools") === "none" ? [] : [
  { key: "seo", label: "SEO", href: "#seo", group: "Tools", children: [{ key: "seo-audit", label: "Audit", href: "#audit" }, { key: "seo-redirects", label: "Redirects", href: "#redirects" }] },
  { key: "forms", label: "Forms", href: "#forms", group: "Tools" },
];
const nav = [
  { key: "home", label: "Home", href: "#home" },
  { key: "pages", label: "Pages", href: "#pages" },
  { key: "posts", label: "Posts", href: "#posts", children: [{ key: "all-posts", label: "All posts", href: "#all" }, { key: "tags", label: "Categories and tags", href: "#tags" }] },
  { key: "plugins", label: "Plugins", href: "#plugins" },
  ...tools,
];
window.__changes = [];
createRoot(document.getElementById("root")).render(
  <Shell dir={dir} nav={nav} selectedKey="pages" title="Pages" onCollapsedChange={(c) => window.__changes.push(c)}>
    <p>Content</p>
  </Shell>);
`;

let site: TestSite;
beforeAll(async () => {
  if (browserPath) site = await startTestSite(ENTRY);
}, 120_000);
afterAll(async () => {
  await site?.close();
});

describe.skipIf(!browserPath)("the side menu", () => {
  test("a main item opens its sub-items under it, and closes them again", async () => {
    const { page } = await site.open(1280);
    const posts = page.getByRole("button", { name: "Posts" });
    expect(await posts.getAttribute("aria-expanded")).toBe("false");
    expect(await page.getByRole("link", { name: "All posts" }).isVisible()).toBe(false);
    await posts.click();
    expect(await posts.getAttribute("aria-expanded")).toBe("true");
    expect(await page.getByRole("link", { name: "All posts" }).isVisible()).toBe(true);
    await posts.click();
    expect(await page.getByRole("link", { name: "All posts" }).isVisible()).toBe(false);
    await page.close();
  });

  test("the current page is marked, and the Tools group has a heading", async () => {
    const { page } = await site.open(1280);
    expect(
      await page.getByRole("link", { name: "Pages", exact: true }).getAttribute("aria-current"),
    ).toBe("page");
    expect(await page.getByText("Tools", { exact: true }).count()).toBe(1);
    await page.close();
  });

  test("the Tools group is not drawn when no plugin has screens", async () => {
    const { page } = await site.open(1280, "light", "?tools=none");
    expect(await page.getByText("Tools", { exact: true }).count()).toBe(0);
    await page.close();
  });

  test("the collapse button switches to the icon rail, every icon keeps its text as its name, and the choice is reported", async () => {
    const { page } = await site.open(1280);
    const before = await page.locator("aside").evaluate((el) => el.getBoundingClientRect().width);
    await page.getByRole("button", { name: "Collapse menu" }).click();
    const after = await page.locator("aside").evaluate((el) => el.getBoundingClientRect().width);
    expect(after).toBeLessThan(before / 2);
    const plugins = page.getByRole("link", { name: "Plugins", exact: true });
    expect(await plugins.getAttribute("title")).toBe("Plugins");
    expect(await plugins.innerText()).not.toContain("Plugins");
    expect(await page.getByRole("button", { name: "Expand menu" }).count()).toBe(1);
    expect(
      await page.evaluate(() => (window as unknown as { __changes: boolean[] }).__changes),
    ).toEqual([true]);
    await page.close();
  });

  test("in the rail, an item with sub-items opens a flyout; Escape closes it and returns focus", async () => {
    const { page } = await site.open(1280);
    await page.getByRole("button", { name: "Collapse menu" }).click();
    const posts = page.getByRole("button", { name: "Posts", exact: true });
    await posts.click();
    expect(await page.getByRole("link", { name: "Categories and tags" }).isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.getByRole("link", { name: "Categories and tags" }).isVisible()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
      "Posts",
    );
    await page.close();
  });

  test("in right-to-left the flyout opens on the left of the rail", async () => {
    const { page } = await site.open(1280, "light", "?dir=rtl");
    await page.getByRole("button", { name: "Collapse menu" }).click();
    const posts = page.getByRole("button", { name: "Posts", exact: true });
    await posts.click();
    const rects = await page.evaluate(() => {
      const flyout = document.querySelector(".oks-flyout:not([hidden])")!.getBoundingClientRect();
      const button = document.querySelector("button[aria-label='Posts']")!.getBoundingClientRect();
      return { flyoutRight: flyout.right, asideLeft: button.left };
    });
    expect(rects.flyoutRight).toBeLessThanOrEqual(rects.asideLeft + 2);
    await page.close();
  });

  test("axe finds no violation in the menu or the rail with a sub-menu open, light and dark", async () => {
    for (const scheme of ["light", "dark"] as const) {
      for (const rail of [false, true]) {
        const { page } = await site.open(1280, scheme);
        if (rail) await page.getByRole("button", { name: "Collapse menu" }).click();
        await page.getByRole("button", { name: "Posts", exact: true }).click();
        await page.addScriptTag({ content: axe.source });
        const result = await page.evaluate(() =>
          (window as unknown as { axe: typeof axe }).axe.run(document, {
            runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
          }),
        );
        expect(
          result.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
          ),
          `${scheme} ${rail ? "rail" : "menu"}`,
        ).toEqual([]);
        await page.close();
      }
    }
  }, 60_000);
});
