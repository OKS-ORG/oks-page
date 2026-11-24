// Reviews in the Business plugin (spec 19, section 6; BZ-03): collected on the site, kept apart until the owner approves them,
// and only approved ones are shown or counted. The route and the block run here with a plain in-memory store.
import { checkBlocks } from "@oks-page/content-safety";
import { writeBlocks } from "@oks-page/renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readPersonalData, readPluginFile } from "../../../packages/sandbox/src/index.js";
import file from "../../../packages/oks-page/src/business-plugin-file.json";
import plugin from "../src/index.js";

type Row = { key: string; value: Record<string, unknown> };
function memory(settings: Record<string, unknown> = {}) {
  const data = new Map<string, Map<string, unknown>>();
  const col = (c: string) => data.get(c) ?? data.set(c, new Map()).get(c)!;
  return {
    data,
    settings: { get: async (k: string) => settings[k] ?? null },
    storage: {
      get: async (c: string, k: string) => col(c).get(k) ?? null,
      set: async (c: string, k: string, v: unknown) => void col(c).set(k, v),
      delete: async (c: string, k: string) => void col(c).delete(k),
      list: async (
        c: string,
        o: { limit?: number; order?: "asc" | "desc" } = {},
      ): Promise<Row[]> => {
        const rows = [...col(c)].map(([key, value]) => ({
          key,
          value: value as Record<string, unknown>,
        }));
        rows.sort((a, b) => a.key.localeCompare(b.key));
        if (o.order === "desc") rows.reverse();
        return rows.slice(0, o.limit ?? 50);
      },
    },
  };
}
type Ctx = ReturnType<typeof memory>;
type Reply = { status: number; page?: { title: string; text: string } };

const route = (ctx: Ctx, body: string) =>
  (plugin.routes as { review: (r: unknown, c: Ctx) => Promise<Reply> }).review(
    { method: "POST", body },
    ctx,
  );
const block = (ctx: Ctx, props: Record<string, unknown> = {}) =>
  (
    plugin.blocks as unknown as Record<string, { render: (p: unknown, c: Ctx) => Promise<unknown> }>
  )["reviews"]!.render(props, ctx);
const html = (node: unknown) =>
  writeBlocks(checkBlocks({ version: 1, blocks: [node] } as never).body.blocks).html;

const T0 = Date.UTC(2026, 10, 25, 10, 0, 0);
let ctx: Ctx;

/** The token of a freshly drawn form. */
async function token(): Promise<string> {
  const node = (await block(ctx)) as { children: { type: string; props: { token: string } }[] };
  return node.children.find((c) => c.type === "form")!.props.token;
}
const send = async (fields: Record<string, string>, t?: string) => {
  const tk = t ?? (await token());
  vi.setSystemTime(T0 + 10_000);
  return route(
    ctx,
    new URLSearchParams({
      _t: tk,
      stars: "5",
      name: "Mia",
      text: "A lovely place, thank you.",
      ...fields,
    }).toString(),
  );
};
const stored = () =>
  [...(ctx.data.get("reviews") ?? new Map())].map(([, v]) => v as Record<string, unknown>);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  ctx = memory();
});
afterEach(() => vi.useRealTimers());

describe("the plugin file", () => {
  test("asks only for the two permissions reviews need, and declares what a privacy request may find", () => {
    const read = readPluginFile(JSON.stringify(file));
    expect(read.ok ? "" : read.message).toBe("");
    if (!read.ok) return;
    expect([...read.file.manifest.permissions].sort()).toEqual(["admin:pages", "routes:public"]);
    expect(read.file.manifest.blocks).toContain("reviews");
    expect(read.file.manifest.routes).toHaveProperty("review");
    expect(read.file.manifest.adminPages?.[0]?.id).toBe("reviews");
    const found = readPersonalData(read.file.manifest.personalData);
    expect(typeof found).not.toBe("string");
    expect(Array.isArray(found) && found[0]).toMatchObject({
      source: "storage:reviews",
      match: ["emails"],
    });
  });
});

describe("sending a review", () => {
  test("a good review is kept waiting for the owner, with the address only for finding it again", async () => {
    const r = await send({ email: "Mia@Example.com" });
    expect(r).toMatchObject({ status: 200, page: { title: "Thank you" } });
    expect(r.page?.text).toContain("shown after the owner has read it");
    expect(stored()).toEqual([
      expect.objectContaining({
        status: "pending",
        stars: 5,
        name: "Mia",
        emails: ["mia@example.com"],
      }),
    ]);
  });

  test.each([
    ["no rating", { stars: "" }, "Your rating"],
    ["a rating of 6", { stars: "6" }, "Your rating"],
    ["a rating that is not a whole number", { stars: "4.5" }, "Your rating"],
    ["no name", { name: " " }, "Your name"],
    ["a review that is too short", { text: "ok" }, "Your review"],
    ["an email that is not one", { email: "mia" }, "Your email"],
  ])("%s is refused in words and nothing is kept", async (_name, fields, words) => {
    const r = await send(fields);
    expect(r.status).toBe(400);
    expect(r.page?.text).toContain(words);
    expect(stored()).toEqual([]);
  });

  test("a program that fills in the hidden field, sends at once, sends a bad signature, or posts links is kept apart as spam, and is told the same thanks", async () => {
    const same = (r: Reply) =>
      expect(r).toMatchObject({ status: 200, page: { title: "Thank you" } });
    same(await send({ _hp: "x" }));
    same(await send({ text: "Visit https://spam.example now please" }));
    same(await send({ text: "buy viagra here, best prices" }));
    same(await send({}, "1234567890123.00000000000000000000000000000000"));
    // Sent the moment the form was drawn.
    const early = await token();
    same(
      await route(
        ctx,
        new URLSearchParams({
          _t: early,
          stars: "5",
          name: "Bo",
          text: "Sent far too quickly",
        }).toString(),
      ),
    );
    expect(stored().length).toBe(5);
    expect(stored().every((v) => v["status"] === "spam")).toBe(true);
  });

  test("a form that was drawn a long time ago is not accepted, and too many in an hour are told thanks and dropped", async () => {
    const old = await token();
    vi.setSystemTime(T0 + 31 * 24 * 3_600_000);
    const r = await route(
      ctx,
      new URLSearchParams({
        _t: old,
        stars: "5",
        name: "Mia",
        text: "A lovely place, thank you.",
      }).toString(),
    );
    expect(r.status).toBe(400);
    expect(r.page?.title).toBe("This page is out of date");
    vi.setSystemTime(T0);
    for (let i = 0; i < 25; i++) await send({ name: `Guest ${i}` });
    expect(stored().length).toBe(20);
  });
});

describe("the reviews block", () => {
  const review = (key: string, v: Record<string, unknown>) =>
    ctx.storage.set("reviews", key, {
      at: T0,
      name: "Mia",
      text: "A lovely place.",
      emails: [],
      ...v,
    });

  test("only approved reviews are shown, newest first, with the average and a form", async () => {
    await review("a", {
      status: "approved",
      stars: 5,
      name: "Anna",
      text: "First review text.",
      at: T0,
    });
    await review("b", { status: "pending", stars: 1, name: "Pat", text: "Waiting for approval." });
    await review("c", { status: "rejected", stars: 1, name: "Rob", text: "Rejected review text." });
    await review("d", { status: "spam", stars: 1, name: "Bot", text: "Spam review text here." });
    await review("e", {
      status: "approved",
      stars: 4,
      name: "Eve <b>",
      text: "Second review text.",
      at: T0 + 1000,
    });
    const out = html(await block(ctx, { title: "What guests say" }));
    expect(out).toContain("What guests say");
    expect(out).toContain("4.5 out of 5, from 2 reviews");
    expect(out.indexOf("Second review text.")).toBeLessThan(out.indexOf("First review text."));
    for (const hidden of ["Waiting for approval", "Rejected review", "Spam review", "Pat", "Rob"])
      expect(out).not.toContain(hidden);
    expect(out).toContain("Eve &lt;b&gt;");
    expect(out).toContain('action="/api/oks/plugins/business/review"');
    expect(out).toContain('name="_t"');
  });

  test("with no reviews it says so; the form can be left out; the number shown is limited", async () => {
    expect(html(await block(ctx))).toContain("There are no reviews yet.");
    for (let i = 0; i < 8; i++)
      await review(`k${i}`, {
        status: "approved",
        stars: 5,
        name: `G${i}`,
        text: `Review number ${i} here.`,
      });
    const some = html(await block(ctx, { most: 3, show_form: false }));
    expect(some.match(/<blockquote/g)?.length).toBe(3);
    expect(some).toContain("from 8 reviews");
    expect(some).not.toContain("<form");
  });
});
