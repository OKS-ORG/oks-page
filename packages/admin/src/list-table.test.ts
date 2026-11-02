// The list table in a real browser (AD-10 to AD-13).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { browserPath, startTestSite, type TestSite } from "./testing/browser-page.js";

const ENTRY = `
const rows = Array.from({ length: 2000 }, (_, i) => ({
  id: i,
  title: "Page " + String(i).padStart(4, "0") + " with a fairly long title to push the table wider than a phone",
  status: i % 2 ? "Draft" : "Published",
}));
createRoot(document.getElementById("root")).render(
  <Shell nav={[{ key: "pages", label: "Pages", href: "#pages" }]} selectedKey="pages" title="Pages">
    <ListTable label="Pages" rows={rows} getRowKey={(r) => r.id}
      columns={[{ key: "title", header: "Title", sortable: true }, { key: "status", header: "Status", sortable: true }]} />
  </Shell>);
`;

let site: TestSite;
beforeAll(async () => {
  if (browserPath) site = await startTestSite(ENTRY);
}, 120_000);
afterAll(async () => {
  await site?.close();
});

describe.skipIf(!browserPath)("the list table", () => {
  test("AD-11: 2,000 items draw 50 rows", async () => {
    const { page } = await site.open(1280);
    expect(await page.locator("tbody tr").count()).toBe(50);
    await page.close();
  });

  test("AD-10: on a phone the table scrolls inside its own box, not the page", async () => {
    const { page } = await site.open(390);
    const result = await page.evaluate(() => {
      // The nearest ancestor of the table that scrolls sideways is the box the table scrolls in.
      const table = document.querySelector("table") as HTMLElement;
      let box: HTMLElement | null = table.parentElement;
      while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowX)) box = box.parentElement;
      return {
        page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        box: box !== null && box !== document.body && box.scrollWidth > box.clientWidth,
      };
    });
    expect(result).toEqual({ page: false, box: true });
    await page.close();
  });

  test("AD-12: rows can be selected and the select-all box shows a partial state", async () => {
    const { page } = await site.open(1280);
    const boxes = page.getByRole("checkbox");
    await boxes.nth(1).check({ force: true });
    const all = boxes.first();
    expect(
      await all.evaluate(
        (el) =>
          (el as HTMLInputElement).indeterminate || el.getAttribute("aria-checked") === "mixed",
      ),
    ).toBe(true);
    await all.check({ force: true });
    expect(await page.getByRole("checkbox", { checked: true }).count()).toBe(51);
    await page.close();
  });

  test("AD-13: the sort button sets aria-sort and reorders the rows across all pages", async () => {
    const { page } = await site.open(1280);
    const header = page.getByRole("columnheader", { name: "Title" });
    await header.getByRole("button").click();
    expect(await header.getAttribute("aria-sort")).toBe("ascending");
    await header.getByRole("button").click();
    expect(await header.getAttribute("aria-sort")).toBe("descending");
    expect(await page.locator("tbody tr").first().textContent()).toContain("Page 1999");
    await page.close();
  });
});
