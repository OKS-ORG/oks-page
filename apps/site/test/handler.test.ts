// The cache handler on its own, with a small in-memory store instead of the database. SEO-59 (the idea), and
// what happens when the store fails.
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const { createHandler } = require("../cache-handlers/create-handler.cjs") as {
  createHandler: (o: unknown) => Handler;
};

interface Handler {
  get(
    key: string,
    soft: string[],
  ): Promise<{ revalidate: number; value: ReadableStream } | undefined>;
  set(key: string, entry: Promise<unknown>): Promise<void>;
  refreshTags(): Promise<void>;
  getExpiration(tags: string[]): Promise<number>;
  updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}
interface Event {
  tag: string;
  stale: number | null;
  expired: number | null;
  updatedAt: number;
}

/** A shared store like the database table: events, written by one handler and read by another. */
function fakeStore() {
  const rows = new Map<string, Event>();
  return {
    rows,
    fail: false,
    async write(
      this: { fail: boolean },
      tags: string[],
      t: { stale: number | null; expired: number | null },
      now: number,
    ) {
      if (this.fail) throw new Error("the database is not reachable");
      for (const tag of tags) {
        const old = rows.get(tag);
        rows.set(tag, {
          tag,
          stale: t.stale ?? old?.stale ?? null,
          expired: t.expired ?? old?.expired ?? null,
          updatedAt: now,
        });
      }
    },
    async readSince(this: { fail: boolean }, since: number) {
      if (this.fail) throw new Error("the database is not reachable");
      return [...rows.values()].filter((r) => r.updatedAt >= since);
    },
  };
}

const bytes = (text: string) =>
  new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(text)), c.close()) });
const entry = (tags: string[], timestamp: number, text = "page") =>
  Promise.resolve({ value: bytes(text), tags, stale: 0, timestamp, expire: 3600, revalidate: 900 });
const read = async (e: { value: ReadableStream } | undefined) =>
  e ? await new Response(e.value).text() : undefined;

function pair() {
  let clock = 1_000_000;
  const store = fakeStore();
  const make = () =>
    createHandler({
      store,
      now: () => clock,
      startedAt: clock,
      onError: errors.push.bind(errors),
    }) as Handler;
  const errors: unknown[] = [];
  return {
    store,
    errors,
    a: make(),
    b: make(),
    tick: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

describe("shared tag state (SEO-59)", () => {
  test("a refresh made through one process reaches the other, on its next request", async () => {
    const { a, b, tick, now } = pair();
    await a.set("page:/about", entry(["entry:1"], now(), "old"));
    await b.set("page:/about", entry(["entry:1"], now(), "old"));
    tick(10);
    await a.updateTags(["entry:1"]); // a publish through process A, expire at once
    expect(await a.get("page:/about", [])).toBeUndefined();
    // Process B has not looked at the store yet. Its next request starts with refreshTags().
    await b.refreshTags();
    expect(await b.get("page:/about", [])).toBeUndefined();
    expect(await b.getExpiration(["entry:1"])).toBeGreaterThan(0);
  });

  test("a refresh of one tag leaves entries with other tags alone", async () => {
    const { a, b, tick, now } = pair();
    await b.set("page:/contact", entry(["entry:2"], now(), "contact"));
    tick(10);
    await a.updateTags(["entry:1"]);
    await b.refreshTags();
    expect(await read(await b.get("page:/contact", []))).toBe("contact");
  });

  test("a time-based refresh ('max') serves the old page once and marks it stale", async () => {
    const { a, b, tick, now } = pair();
    await b.set("page:/about", entry(["entry:1"], now(), "old"));
    tick(10);
    await a.updateTags(["entry:1"], { expire: 3600 });
    await b.refreshTags();
    const hit = await b.get("page:/about", []);
    expect(await read(hit)).toBe("old");
    expect(hit!.revalidate).toBe(-1); // Next.js serves it and renews it in the background
  });

  test("a page made after the refresh is fresh", async () => {
    const { a, b, tick, now } = pair();
    tick(10);
    await a.updateTags(["entry:1"]);
    tick(10);
    await b.set("page:/about", entry(["entry:1"], now(), "new"));
    await b.refreshTags();
    expect(await read(await b.get("page:/about", []))).toBe("new");
  });

  test("refreshing the same tag twice keeps the later time", async () => {
    const { a, b, tick } = pair();
    await a.updateTags(["entry:1"]);
    const first = await a.getExpiration(["entry:1"]);
    tick(500);
    await a.updateTags(["entry:1"]);
    await b.refreshTags();
    expect(await b.getExpiration(["entry:1"])).toBeGreaterThan(first);
  });
});

describe("when the shared store fails", () => {
  test("refreshTags does not throw, reports the error, and the last known state still applies", async () => {
    const { store, errors, a, b, tick, now } = pair();
    await b.set("page:/about", entry(["entry:1"], now()));
    tick(10);
    await a.updateTags(["entry:1"]);
    await b.refreshTags(); // knows about the refresh
    store.fail = true;
    await expect(b.refreshTags()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(await b.get("page:/about", [])).toBeUndefined();
  });

  test("updateTags does not throw; this process still applies the refresh itself", async () => {
    const { store, errors, a, tick, now } = pair();
    await a.set("page:/about", entry(["entry:1"], now()));
    tick(10);
    store.fail = true;
    await expect(a.updateTags(["entry:1"])).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(await a.get("page:/about", [])).toBeUndefined();
  });

  test("an entry that fails while it is made is dropped, not stored", async () => {
    const { errors, a } = pair();
    await a.set("page:/broken", Promise.reject(new Error("render failed")));
    expect(await a.get("page:/broken", [])).toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe("memory", () => {
  test("the oldest entries are dropped when there are too many", async () => {
    const store = fakeStore();
    const h = createHandler({ store, maxEntries: 3, now: () => 1 }) as Handler;
    for (const n of [1, 2, 3, 4]) await h.set(`k${n}`, entry([], 1, `v${n}`));
    expect(await h.get("k1", [])).toBeUndefined();
    expect(await read(await h.get("k4", []))).toBe("v4");
  });

  test("an entry that is read stays; the one not read is dropped first", async () => {
    const h = createHandler({ store: fakeStore(), maxEntries: 3, now: () => 1 }) as Handler;
    for (const n of [1, 2, 3]) await h.set(`k${n}`, entry([], 1, `v${n}`));
    await h.get("k1", []);
    await h.set("k4", entry([], 1, "v4"));
    expect(await h.get("k2", [])).toBeUndefined();
    expect(await read(await h.get("k1", []))).toBe("v1");
  });
});
