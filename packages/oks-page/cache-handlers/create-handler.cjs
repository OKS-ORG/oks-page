"use strict";
// The cache handler for 'use cache' (Next.js 16 `cacheHandlers`, see the Next.js documentation "cacheHandlers").
//
// - The cached pages are kept IN THIS PROCESS (a size-limited Map).
// - Which tags were refreshed, and when, is SHARED through a store (the database table `cache_tags`, decision D82),
//   so a publish made through one server process reaches every other process:
//     updateTags()  writes the event to the store,
//     refreshTags() reads the events written since the last look, before each request.
// A failing store never fails a request: the handler keeps the last tag state it knows and tells `onError`.
//
// `store` has two functions:
//   write(tags, { stale, expired }, now): record that these tags were refreshed (milliseconds; `stale` and `expired` may be null)
//   readSince(sinceMs): the events with updatedAt >= sinceMs, as { tag, stale, expired, updatedAt }

const OVERLAP_MS = 5000;

function streamFromBytes(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function createHandler({
  store,
  now = Date.now,
  maxEntries = 1000,
  onError = () => {},
  startedAt = now(),
} = {}) {
  /** @type {Map<string, any>} */
  const entries = new Map();
  const pending = new Map();
  /** tag -> { stale, expired } in milliseconds */
  const tagTimes = new Map();
  let cursor = startedAt - 60_000;

  const merge = (tag, stale, expired) => {
    const t = tagTimes.get(tag) ?? {};
    if (stale != null) t.stale = Math.max(t.stale ?? 0, stale);
    if (expired != null) t.expired = Math.max(t.expired ?? 0, expired);
    tagTimes.set(tag, t);
  };

  return {
    // Soft tags (from revalidatePath) reach us through getExpiration(), which Next.js asks for itself.
    async get(cacheKey) {
      const wait = pending.get(cacheKey);
      if (wait) await wait;
      const entry = entries.get(cacheKey);
      if (!entry) return undefined;
      // Most recently used goes last, so the oldest is first in line to be dropped.
      entries.delete(cacheKey);
      entries.set(cacheKey, entry);
      let revalidate = entry.revalidate;
      for (const tag of entry.tags) {
        const { stale = 0, expired = 0 } = tagTimes.get(tag) ?? {};
        if (expired > entry.timestamp && expired <= now()) return undefined;
        if (stale > entry.timestamp) revalidate = -1;
      }
      return { ...entry, revalidate, value: streamFromBytes(entry.value) };
    },

    async set(cacheKey, pendingEntry) {
      let done;
      pending.set(cacheKey, new Promise((resolve) => (done = resolve)));
      try {
        const entry = await pendingEntry;
        // Keep the bytes, never the stream: the stream holds the request that made it.
        const value = new Uint8Array(await new Response(entry.value).arrayBuffer());
        entries.delete(cacheKey);
        entries.set(cacheKey, { ...entry, value });
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      } catch (e) {
        onError(e); // an incomplete value is dropped; the next request renders again
      } finally {
        done();
        pending.delete(cacheKey);
      }
    },

    async refreshTags() {
      try {
        const events = await store.readSince(cursor - OVERLAP_MS);
        for (const e of events) {
          merge(e.tag, e.stale, e.expired);
          if (e.updatedAt > cursor) cursor = e.updatedAt;
        }
      } catch (e) {
        onError(e); // keep serving with the tag state this process already knows
      }
    },

    async getExpiration(tags) {
      return Math.max(...tags.map((tag) => tagTimes.get(tag)?.expired ?? 0), 0);
    },

    async updateTags(tags, durations) {
      const t = now();
      const stale = durations ? t : null;
      const expired = durations
        ? durations.expire !== undefined
          ? t + durations.expire * 1000
          : null
        : t;
      for (const tag of tags) merge(tag, stale, expired);
      try {
        await store.write(tags, { stale, expired }, t);
      } catch (e) {
        onError(e); // this process still knows; the others will learn when the store is back and the tag is refreshed again
      }
    },
  };
}

module.exports = { createHandler };
