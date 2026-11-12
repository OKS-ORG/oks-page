// Image sizes on public pages, on SQLite and PostgreSQL.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import type { StorageAdapter } from "@oks-page/media";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { enhanceImages } from "./media-html.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const storage = {
  publicUrl: (key: string) => `/uploads/${key.split("/").map(encodeURIComponent).join("/")}`,
} as unknown as StorageAdapter;
const BLUR =
  "data:image/webp;base64,UklGRhoAAABXRUJQVlA4IA4AAAAwAQCdASoBAAEAAUAmJZQAA3AA/v89WAAAAA==";

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: image sizes on public pages`, () => {
    let db: TestDb;
    let siteId = "";
    let userId = "";
    const image = async (
      key: string,
      options: { status?: string; variants?: boolean; blur?: string | null } = {},
    ) => {
      const id = newId();
      await db.run(
        `insert into media (id, site_id, storage_key, filename, mime_type, size_bytes, width, height, blur_placeholder, content_hash, status, uploaded_by, created_at)
         values (?, ?, ?, ?, 'image/png', 1, 1600, 900, ?, ?, ?, ?, ?)`,
        [
          id,
          siteId,
          key,
          key.split("/").pop(),
          options.blur === undefined ? BLUR : options.blur,
          id,
          options.status ?? "ready",
          userId,
          T,
        ],
      );
      if (options.variants !== false)
        for (const width of [320, 640])
          for (const format of ["webp", "avif"])
            await db.run(
              `insert into media_variants (media_id, width, format, storage_key, size_bytes) values (?, ?, ?, ?, 1)`,
              [id, width, format, key.replace(/\.png$/, `-${width}.${format}`)],
            );
      return id;
    };
    const tag = (src: string, alt = "A view") => `<img src="${src}" alt="${alt}" loading="lazy">`;
    const run = (html: string) => enhanceImages(db.runner, siteId, html, storage);

    beforeEach(async () => {
      db = await open();
      const setup = await runSetup(
        db.runner,
        async ({ name, email }) => {
          const id = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, name, email, T, T],
          );
          return { userId: id };
        },
        {
          siteName: "S",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      userId = setup.userId;
    });
    afterEach(async () => db.close());

    test("a library image becomes a picture with sizes in AVIF and WebP, a blur and its dimensions", async () => {
      await image("2026/11/abc-view.png");
      const out = await run(`<figure>${tag("/uploads/2026/11/abc-view.png")}</figure>`);
      expect(out).toContain("<picture>");
      expect(out).toContain(
        `<source type="image/avif" srcset="/uploads/2026/11/abc-view-320.avif 320w, /uploads/2026/11/abc-view-640.avif 640w" sizes="(min-width: 960px) 960px, 100vw">`,
      );
      expect(out).toContain(
        `<source type="image/webp" srcset="/uploads/2026/11/abc-view-320.webp 320w`,
      );
      // The original stays as the fallback, with its words, its size and the blurred copy behind it.
      expect(out).toContain(
        `<img src="/uploads/2026/11/abc-view.png" alt="A view" loading="lazy" decoding="async" width="1600" height="900" style="background-image:url('${BLUR}');background-size:cover">`,
      );
      expect(out.startsWith("<figure><picture>")).toBe(true);
    });

    test("what is not a ready library image is left exactly as it was", async () => {
      await image("2026/11/slow.png", { status: "processing", variants: false });
      const html = [
        tag("/uploads/2026/11/slow.png"),
        tag("https://example.com/outside.png"),
        tag("/uploads/2026/11/not-in-library.png"),
        "<p>no pictures here</p>",
      ].join("");
      expect(await run(html)).toBe(html);
    });

    test("an image without sizes (a GIF, say) still gets its dimensions; a bad blur is not used", async () => {
      await image("2026/11/anim.png", { variants: false });
      expect(await run(tag("/uploads/2026/11/anim.png"))).toBe(
        `<img src="/uploads/2026/11/anim.png" alt="A view" loading="lazy" decoding="async" width="1600" height="900" style="background-image:url('${BLUR}');background-size:cover">`,
      );
      await image("2026/11/odd.png", { variants: false, blur: `data:x');color:red;--a:url('` });
      const out = await run(tag("/uploads/2026/11/odd.png"));
      expect(out).not.toContain("style=");
      expect(out).toContain('width="1600"');
    });

    test("file names with spaces or marks work, and another site's image is not touched", async () => {
      await image("2026/11/my photo (1).png");
      const out = await run(tag("/uploads/2026/11/my%20photo%20(1).png", "Tom &amp; Jerry"));
      expect(out).toContain("<picture>");
      expect(out).toContain('alt="Tom &amp; Jerry"');
      expect(out).toContain("my%20photo%20(1)-320.webp 320w");
    });
  });
}
