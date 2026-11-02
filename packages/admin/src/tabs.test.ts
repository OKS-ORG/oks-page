// The tab strip and the footer (spec 07 section 3a, D111, D112), in a real browser.
import axe from "axe-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { browserPath, startTestSite, type TestSite } from "./testing/browser-page.js";

const ENTRY = `
import { useState } from "react";
const params = new URLSearchParams(location.search);
const many = params.get("many") === "1";
const start = [
  { key: "dashboard", title: "Dashboard", href: "#dashboard" },
  { key: "about", title: "About us", href: "#about", dirty: true },
  { key: "contact", title: "Contact", href: "#contact" },
  ...(many ? ["Team", "Jobs", "News", "Press"].map((t) => ({ key: t.toLowerCase(), title: t, href: "#" + t.toLowerCase() })) : []),
];
function App() {
  const [tabs, setTabs] = useState(start);
  const [active, setActive] = useState("dashboard");
  return (
    <Shell nav={[{ key: "pages", label: "Pages", href: "#pages" }]} selectedKey="pages" title="Pages"
      tabs={{ tabs, activeKey: active, onSelect: (t) => setActive(t.key),
        onClose: (t) => { setTabs((all) => all.filter((x) => x.key !== t.key)); setActive("dashboard"); },
        addItems: [{ key: "page", label: "Page", href: "#new-page" }, { key: "post", label: "Post", href: "#new-post" }],
        onAdd: (i) => { location.hash = i.href; } }}
      footer={params.get("footer") === "off" ? undefined : { product: "oks.page", version: "1.0.0", helpHref: "#help", docsHref: "#docs" }}>
      <p>Content</p>
    </Shell>);
}
createRoot(document.getElementById("root")).render(<App />);
`;

let site: TestSite;
beforeAll(async () => {
  if (browserPath) site = await startTestSite(ENTRY);
}, 120_000);
afterAll(async () => {
  await site?.close();
});

describe.skipIf(!browserPath)("the tab strip and the footer", () => {
  test("Dashboard is the first tab, is selected, and has no close button", async () => {
    const { page } = await site.open(1280);
    const tabs = page.getByRole("tab");
    expect(await tabs.first().textContent()).toBe("Dashboard");
    expect(await tabs.first().getAttribute("aria-selected")).toBe("true");
    expect(await page.getByRole("button", { name: "Close Dashboard" }).count()).toBe(0);
    await page.getByRole("tab", { name: "Contact" }).click();
    expect(await page.getByRole("button", { name: "Close Contact" }).count()).toBe(1);
    await page.close();
  });

  test("selecting a tab selects it; arrow keys, Home and End move between tabs", async () => {
    const { page } = await site.open(1280);
    await page.getByRole("tab", { name: "Contact" }).click();
    expect(await page.getByRole("tab", { name: "Contact" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(await page.getByRole("tab", { name: "Dashboard" }).getAttribute("tabindex")).toBe("-1");
    await page.keyboard.press("Home");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Dashboard");
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("About us");
    await page.keyboard.press("End");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Contact");
    await page.close();
  });

  test("a tab with unsaved changes says so, and closing it asks first", async () => {
    const { page } = await site.open(1280);
    expect(await page.getByRole("tab", { name: /About us/ }).textContent()).toContain(
      "unsaved changes",
    );
    await page.getByRole("tab", { name: /About us/ }).click();
    await page.getByRole("button", { name: "Close About us" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await dialog.waitFor({ state: "detached" });
    expect(await page.getByRole("tab", { name: /About us/ }).count()).toBe(1);
    await page.getByRole("tab", { name: /About us/ }).click();
    await page.getByRole("button", { name: "Close About us" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Close tab" }).click();
    await expect.poll(() => page.getByRole("tab", { name: /About us/ }).count()).toBe(0);
    await page.close();
  });

  test("a tab without changes closes at once", async () => {
    const { page } = await site.open(1280);
    await page.getByRole("tab", { name: "Contact" }).click();
    await page.getByRole("button", { name: "Close Contact" }).click();
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(await page.getByRole("tab", { name: "Contact" }).count()).toBe(0);
    await page.close();
  });

  test("the plus button opens the Add new menu", async () => {
    const { page } = await site.open(1280);
    const plus = page.getByRole("button", { name: "Add new" });
    expect(await plus.getAttribute("aria-expanded")).toBe("false");
    await plus.click();
    expect(await plus.getAttribute("aria-expanded")).toBe("true");
    await page.getByRole("link", { name: "Post" }).click();
    expect(await page.evaluate(() => location.hash)).toBe("#new-post");
    await page.close();
  });

  test("the All tabs menu appears only when there are many tabs", async () => {
    const few = await site.open(1280);
    expect(await few.page.getByRole("button", { name: "All tabs" }).count()).toBe(0);
    await few.page.close();
    const many = await site.open(1280, "light", "?many=1");
    await many.page.getByRole("button", { name: "All tabs" }).click();
    await many.page.getByRole("link", { name: "Press" }).click();
    expect(await many.page.getByRole("tab", { name: "Press" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    await many.page.close();
  });

  test("the footer shows the product, version, Help and Docs, and can be left out", async () => {
    const { page } = await site.open(1280);
    expect(await page.locator("footer").textContent()).toContain(
      "Developed with oks.page · Version 1.0.0",
    );
    expect(await page.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("#docs");
    await page.close();
    const off = await site.open(1280, "light", "?footer=off");
    expect(await off.page.locator("footer").count()).toBe(0);
    await off.page.close();
  });

  test("with many tabs there is no sideways page scroll at 320 px, and axe finds no violation, light and dark", async () => {
    for (const scheme of ["light", "dark"] as const) {
      for (const width of [1280, 320]) {
        const { page } = await site.open(width, scheme, "?many=1");
        await page.getByRole("button", { name: "Add new" }).click();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
          ),
          `${scheme} ${width}px scroll`,
        ).toBe(false);
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
