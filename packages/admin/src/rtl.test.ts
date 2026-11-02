// The admin shell mirrored for right-to-left languages (spec 12, section 6; RTL-10 for the shell).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { browserPath, startTestSite, type TestSite } from "./testing/browser-page.js";

const ENTRY = `
const dir = new URLSearchParams(location.search).get("dir") === "rtl" ? "rtl" : "ltr";
document.documentElement.setAttribute("dir", dir);
createRoot(document.getElementById("root")).render(
  <Shell dir={dir} nav={[{ key: "pages", label: "Pages", href: "#pages" }, { key: "posts", label: "Posts", href: "#posts" }]}
    selectedKey="pages" title="Pages" breadcrumbs={[{ label: "Home", href: "#home" }, { label: "Pages" }]}>
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

type Box = { x: number; w: number };
const box = (selector: string): Box | null => {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, w: r.width };
};

describe.skipIf(!browserPath)("the admin shell in right-to-left", () => {
  test("RTL-10: at 1280 px the sidebar, header and content mirror the left-to-right layout", async () => {
    for (const selector of ["aside", ".oks-header", "main"]) {
      const ltr = await site.open(1280, "light", "?dir=ltr");
      const rtl = await site.open(1280, "light", "?dir=rtl");
      const a = await ltr.page.evaluate(box, selector);
      const b = await rtl.page.evaluate(box, selector);
      expect(a, selector).not.toBeNull();
      // The mirrored left edge is the page width minus the right edge.
      expect(Math.abs(b!.x - (1280 - (a!.x + a!.w))), selector).toBeLessThanOrEqual(2);
      await ltr.page.close();
      await rtl.page.close();
    }
  });

  test("RTL-10: the breadcrumbs and the Search button swap sides", async () => {
    const ltr = await site.open(1280, "light", "?dir=ltr");
    const rtl = await site.open(1280, "light", "?dir=rtl");
    const sides = (page: typeof ltr.page) =>
      page.evaluate(() => {
        const crumb = document.querySelector(".oks-header nav")!.getBoundingClientRect();
        const search = [...document.querySelectorAll(".oks-header button")]
          .find((b) => b.textContent === "Search")!
          .getBoundingClientRect();
        return crumb.left < search.left ? "crumbs-first-on-left" : "crumbs-first-on-right";
      });
    expect(await sides(ltr.page)).toBe("crumbs-first-on-left");
    expect(await sides(rtl.page)).toBe("crumbs-first-on-right");
    await ltr.page.close();
    await rtl.page.close();
  });

  test("the drawer opens on the right in right-to-left and on the left in left-to-right, with no sideways scroll", async () => {
    for (const dir of ["ltr", "rtl"] as const) {
      const { page } = await site.open(390, "light", `?dir=${dir}`);
      await page.getByRole("button", { name: "Menu" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      // The drawer slides in, so wait until it has stopped moving.
      const edge = () =>
        dialog.evaluate(
          (el, side) => Math.round(el.getBoundingClientRect()[side]),
          dir === "rtl" ? "right" : "left",
        );
      await expect.poll(edge, { timeout: 3000 }).toBe(dir === "rtl" ? 390 : 0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ),
      ).toBe(false);
      await page.close();
    }
  });
});
