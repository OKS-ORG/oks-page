// The admin shell in a real browser (AD-01 to AD-09, AD-14): the shell is bundled with the real oks-ui and driven in Chromium.
import axe from "axe-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { browserPath, startTestSite, type TestSite } from "./testing/browser-page.js";

const ENTRY = `
import { Table } from "oks-ui";
const nav = [
  { key: "dashboard", label: "Dashboard", href: "#dashboard" },
  { key: "pages", label: "Pages", href: "#pages" },
  { key: "plugins", label: "Plugins (2 new)", href: "#plugins" },
];
const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, title: "Page " + i + " with a fairly long title to push the table wider", status: "Published" }));
createRoot(document.getElementById("root")).render(
  <Shell nav={nav} selectedKey="pages" title="Pages" breadcrumbs={[{ label: "Home", href: "#dashboard" }, { label: "Pages" }]}
    searchItems={[{ id: "plugins", label: "Plugins", href: "#plugins" }]} onSearch={async (q) => (q === "zeta" ? [{ id: "e1", label: "Zeta page", href: "#zeta" }] : [])} onNavigate={(h) => { location.hash = h; }}>
    <Table aria-label="Pages" columns={[{ key: "title", header: "Title" }, { key: "status", header: "Status" }]} rows={rows} getRowKey={(r) => r.id} />
  </Shell>);
`;

let site: TestSite;
beforeAll(async () => {
  if (browserPath) site = await startTestSite(ENTRY);
}, 120_000);
afterAll(async () => {
  await site?.close();
});

describe.skipIf(!browserPath)("the admin shell", () => {
  test("AD-01, AD-14: no sideways page scroll at 1280, 1024, 768, 390 and 320 px, and no page errors", async () => {
    for (const width of [1280, 1024, 768, 390, 320]) {
      const { page, errors } = await site.open(width);
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(sideways, `${width}px`).toBe(false);
      expect(errors).toEqual([]);
      await page.close();
    }
  });

  test("AD-02: the sidebar shows at 1025 px and above; a Menu button below", async () => {
    const wide = await site.open(1025);
    expect(await wide.page.locator("aside nav").count()).toBe(1);
    expect(await wide.page.getByRole("button", { name: "Menu", exact: true }).count()).toBe(0);
    await wide.page.close();
    const narrow = await site.open(1024);
    expect(await narrow.page.locator("aside").count()).toBe(0);
    expect(await narrow.page.getByRole("button", { name: "Menu", exact: true }).count()).toBe(1);
    await narrow.page.close();
  });

  test("AD-04, AD-05: the drawer is a dialog with the menu, and Escape returns focus to the Menu button", async () => {
    const { page } = await site.open(390);
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    expect(await dialog.getByRole("link", { name: "Dashboard" }).count()).toBe(1);
    // Focus moves into the dialog a moment after it opens, so wait for it (a slow machine needs longer).
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest("[role=dialog]") !== null))
      .toBe(true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Menu");
    await page.close();
  });

  test("AD-06, AD-07: Ctrl+K opens the search, typing and Enter go to the item", async () => {
    const { page } = await site.open(1280);
    await page.keyboard.press("Control+k");
    const box = page.getByRole("combobox");
    await box.waitFor();
    await box.fill("plug");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => location.hash)).toBe("#plugins");
    await page.close();
  });

  test("AD-06b: the search also asks the lookup after a short pause, and shows what it finds", async () => {
    const { page } = await site.open(1280);
    await page.keyboard.press("Control+k");
    const box = page.getByRole("combobox");
    await box.fill("zeta");
    await page.getByRole("option", { name: "Zeta page" }).waitFor();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => location.hash)).toBe("#zeta");
    await page.close();
  });

  test("AD-08, AD-09: Skip to content is the first Tab stop and moves focus to the main area", async () => {
    const { page } = await site.open(1280);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Skip to content");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("main");
    await page.close();
  });

  test("AD-03: axe finds no violation at 1280, 1024, 768, 390 and 320 px, in light and dark", async () => {
    for (const scheme of ["light", "dark"] as const) {
      for (const width of [1280, 1024, 768, 390, 320]) {
        const { page } = await site.open(width, scheme);
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
          `${scheme} ${width}px`,
        ).toEqual([]);
        await page.close();
      }
    }
  }, 60_000);
});
