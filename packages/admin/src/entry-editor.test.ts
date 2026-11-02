// The entry editor in a real browser: the blocks go to the server's block checks on save, and the person is told what was fixed.
import { checkBlocks } from "@oks-page/content-safety";
import axe from "axe-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { browserPath, startTestSite, type TestSite } from "./testing/browser-page.js";

const ENTRY = `
import { Button } from "oks-ui";
const hostile = [
  { id: "a", type: "paragraph", props: {}, content: [{ type: "text", text: "Hello", styles: { color: 'red" onmouseover="alert(1)' } }], children: [] },
  { id: "a", type: "image", props: { src: "javascript:alert(1)", alt: "x" }, content: null, children: [] },
];
const clean = [{ id: "c", type: "paragraph", props: {}, content: [{ type: "text", text: "Hello", styles: {} }], children: [] }];
const which = new URLSearchParams(location.search).get("blocks");
const failing = new URLSearchParams(location.search).get("fail") === "1";
window.__dirty = [];
createRoot(document.getElementById("root")).render(
  <Shell nav={[{ key: "pages", label: "Pages", href: "#pages" }]} selectedKey="pages" title="Edit page">
    <EntryEditor initialBlocks={which === "hostile" ? hostile : clean}
      onDirtyChange={(d) => window.__dirty.push(d)}
      onSave={async (blocks) => { if (failing) throw new Error("offline"); return await window.saveToServer(blocks); }} />
  </Shell>);
`;

let site: TestSite;
beforeAll(async () => {
  if (browserPath) site = await startTestSite(ENTRY);
}, 120_000);
afterAll(async () => {
  await site?.close();
});

describe.skipIf(!browserPath)("the entry editor", () => {
  test("hostile blocks are repaired by the block checks on save, and the person is told", async () => {
    const received: unknown[] = [];
    const { page } = await site.open(1280, "light", "?blocks=hostile", async (p) => {
      await p.exposeFunction("saveToServer", (blocks: unknown) => {
        const result = checkBlocks({ version: 1, blocks });
        received.push(result.body);
        return { repairs: result.repairs };
      });
    });
    await page.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(() => page.locator(".oks-entry-actions [role=status]").textContent())
      .toMatch(/Saved\. We fixed \d+ things? that were not safe or not valid\./);
    const stored = JSON.stringify(received[0]);
    expect(stored).not.toContain("javascript:");
    expect(stored).not.toContain("onmouseover");
    expect((received[0] as { blocks: { id: string }[] }).blocks.map((b) => b.id)).toEqual([
      ...new Set((received[0] as { blocks: { id: string }[] }).blocks.map((b) => b.id)),
    ]);
    await page.close();
  });

  test("clean blocks save with no repairs", async () => {
    const { page } = await site.open(1280, "light", "", async (p) => {
      await p.exposeFunction("saveToServer", (blocks: unknown) => ({
        repairs: checkBlocks({ version: 1, blocks }).repairs,
      }));
    });
    await page.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(() => page.locator(".oks-entry-actions [role=status]").textContent())
      .toBe("Saved.");
    await page.close();
  });

  test("typing marks the entry as having unsaved changes, and saving clears it", async () => {
    const { page } = await site.open(1280, "light", "", async (p) => {
      await p.exposeFunction("saveToServer", () => ({ repairs: [] }));
    });
    await page.locator("[contenteditable=true]").first().click();
    await page.keyboard.type(" more");
    await page.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(() => page.locator(".oks-entry-actions [role=status]").textContent())
      .toBe("Saved.");
    expect(
      await page.evaluate(() => (window as unknown as { __dirty: boolean[] }).__dirty),
    ).toEqual([true, false]);
    await page.close();
  });

  test("a failed save keeps the changes and says so", async () => {
    const { page } = await site.open(1280, "light", "?fail=1", async (p) => {
      await p.exposeFunction("saveToServer", () => ({ repairs: [] }));
    });
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").textContent()).toContain("try again");
    await page.close();
  });

  test("axe finds no violation on the editor screen, light and dark", async () => {
    for (const scheme of ["light", "dark"] as const) {
      const { page } = await site.open(1280, scheme, "", async (p) => {
        await p.exposeFunction("saveToServer", () => ({ repairs: [] }));
      });
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
        scheme,
      ).toEqual([]);
      await page.close();
    }
  });
});
