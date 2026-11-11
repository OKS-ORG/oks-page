"use strict";
// Loaded by Next.js (next.config.mjs, `cacheHandlers.default`).
const { createHandler } = require("./create-handler.cjs");
const { dbStore } = require("./db-store.cjs");

module.exports = createHandler({
  store: dbStore(),
  onError: (e) => console.error("[oks cache] " + (e && e.message ? e.message : e)),
});
