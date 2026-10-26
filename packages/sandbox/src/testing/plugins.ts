// Plugins used to test the sandbox: honest ones, and hostile ones that try everything a plugin author might try.
import type { PluginManifest } from "../types.js";

export interface TestPlugin {
  manifest: PluginManifest;
  code: string;
}

export const PLUGINS: Record<string, TestPlugin> = {
  "reading-time": {
    manifest: {
      id: "reading-time",
      displayName: "Reading Time",
      version: "1.0.0",
      permissions: ["content:read", "content:write"],
    },
    code: `export default {
  hooks: { "content:beforeSave": async (entry, ctx) => {
    const words = String(entry.plainText || "").split(/\\s+/).filter(Boolean).length;
    return { ...entry, meta: { ...(entry.meta || {}), readingTime: Math.max(1, Math.round(words / 200)) } };
  } },
  blocks: { "reading-time": { render: async (props) => ({ type: "paragraph", props: {}, content: [{ type: "text", text: String(props.minutes) + " min read" }], children: [] }) } },
};`,
  },
  "no-write": {
    manifest: { id: "no-write", version: "1.0.0", permissions: ["content:read"] },
    code: `export default { hooks: {
  "content:beforeSave": async (e, ctx) => { await ctx.content.update("e1", { title: "hacked" }); return e; },
} };`,
  },
  drafts: {
    manifest: { id: "drafts", version: "1.0.0", permissions: ["content:read"] },
    code: `export default { hooks: { "content:afterSave": async (e, ctx) => ({
  pub: (await ctx.content.get("e1")).title,
  draft: await ctx.content.get("draft1").then(() => "READ", (er) => er.code),
}) } };`,
  },
  "hostile-block": {
    manifest: { id: "hostile-block", version: "1.0.0", permissions: [] },
    code: `export default { blocks: { "hostile-block": { render: async () => ({
  type: "image",
  props: { src: "javascript:alert(1)", color: "red\\" onmouseover=\\"alert(1)" },
  content: [{ type: "link", href: "javascript:alert(1)", content: [{ type: "text", text: "x" }] }],
  children: [],
}) } } };`,
  },
  looper: {
    manifest: { id: "looper", version: "1.0.0", permissions: [] },
    code: `export default { hooks: { "content:beforeSave": async (e) => { if (e.title === "LOOP") for (;;) {} return e; } } };`,
  },
  hog: {
    manifest: { id: "hog", version: "1.0.0", permissions: [] },
    code: `export default { hooks: { "content:beforeSave": async (e) => { if (e.title === "HOG") { const a = []; for (;;) a.push(new Array(1e6).fill(1)); } return e; } } };`,
  },
  thrower: {
    manifest: { id: "thrower", displayName: "Thrower", version: "1.0.0", permissions: [] },
    code: `export default { hooks: { "content:beforeSave": async () => { throw new Error("boom"); } } };`,
  },
  exiter: {
    manifest: { id: "exiter", displayName: "Exiter", version: "1.0.0", permissions: [] },
    code: `export default { hooks: { "content:beforeSave": async (e) => { process.exit(0); return e; } } };`,
  },
  storer: {
    manifest: { id: "storer", version: "1.0.0", permissions: [] },
    code: `export default { hooks: { "content:afterSave": async (e, ctx) => {
  let n = 0;
  try { for (;;) { await ctx.storage.set("c", "k" + n, "x".repeat(4000)); n++; if (n > 500) break; } }
  catch (er) { return { stoppedAfter: n, code: er.code }; }
  return { stoppedAfter: n };
} } };`,
  },
  keeper: {
    manifest: { id: "keeper", version: "1.0.0", permissions: [] },
    code: `export default { hooks: { "content:afterSave": async (e, ctx) => {
  await ctx.storage.set("c", "../reading-time/c/k", "mine");
  await ctx.storage.set("notes", "greeting", { hello: "world" });
  return { tricky: await ctx.storage.get("c", "../reading-time/c/k"), notes: await ctx.storage.get("notes", "greeting") };
} } };`,
  },
  netter: {
    manifest: { id: "netter", version: "1.0.0", permissions: ["network:fetch:127.0.0.1"] },
    code: `export default { hooks: { "content:afterSave": async (e, ctx) => {
  const out = {};
  const t = async (name, url) => { try { const r = await ctx.http.fetch(url); out[name] = "status " + r.status + " " + r.text.slice(0, 20); } catch (er) { out[name] = er.code || er.message; } };
  await t("allowed host", e.base + "/ok");
  await t("not approved host", e.base.replace("127.0.0.1", "localhost") + "/ok");
  await t("redirect", e.base + "/redirect");
  await t("file scheme", "file:///etc/passwd");
  return out;
} } };`,
  },
  attacker: {
    manifest: { id: "attacker", version: "1.0.0", permissions: [] },
    code: `export default { hooks: { "content:afterSave": async (e, ctx) => {
  const r = {};
  const t = async (n, f) => { try { r[n] = await f(); } catch (er) { r[n] = "blocked: " + String((er && er.message) || er).slice(0, 90); } };
  await t("process.env", async () => JSON.stringify(Object.keys(process.env || {})));
  await t("require", async () => typeof require);
  await t("eval", async () => eval("1+1"));
  await t("new Function", async () => new Function("return 2")());
  await t("fetch internet", async () => { const x = await fetch("http://example.com/"); return "status " + x.status + " " + (await x.text()).slice(0, 60); });
  await t("fetch cloud metadata", async () => { const x = await fetch("http://169.254.169.254/latest/meta-data/"); return "status " + x.status + " " + (await x.text()).slice(0, 60); });
  await t("fetch host admin route", async () => { const x = await fetch("http://host/admin/users", { method: "POST", body: "{}" }); return "status " + x.status; });
  await t("fetch host without token", async () => { const x = await fetch("http://host/content/get", { method: "POST", body: JSON.stringify({ id: "e1" }) }); return "status " + x.status + " " + (await x.text()).slice(0, 60); });
  await t("fetch other plugin directly", async () => { const x = await fetch("http://127.0.0.1:" + e.otherPort + "/hook/content:beforeSave", { method: "POST", body: JSON.stringify({ event: { plainText: "a b c" } }) }); return "status " + x.status; });
  await t("guess other token", async () => { const x = await fetch("http://host/content/update", { method: "POST", headers: { "x-plugin-token": "0".repeat(32) }, body: JSON.stringify({ id: "e1", patch: { title: "x" } }) }); return "status " + x.status; });
  await t("prototype pollution", async () => { Object.prototype.polluted = 1; return "set (inside this process only)"; });
  return r;
} } };`,
  },
  attacker2: {
    manifest: { id: "attacker2", version: "1.0.0", permissions: [] },
    code: `export default { hooks: { "content:afterSave": async (e, ctx) => {
  const r = {};
  const t = async (n, f) => { try { r[n] = await f(); } catch (er) { r[n] = "blocked: " + String((er && er.message) || er).slice(0, 90); } };
  await t("fs read /etc/passwd", async () => { const fs = await import("node:fs"); return "READ " + fs.readFileSync("/etc/passwd", "utf8").slice(0, 40); });
  await t("fs list /", async () => { const fs = await import("node:fs"); return JSON.stringify(fs.readdirSync("/")); });
  await t("fs read the host's folder", async () => { const fs = await import("node:fs"); return JSON.stringify(fs.readdirSync(e.hostDir)); });
  await t("node:child_process", async () => { const m = await import("node:child_process"); return typeof m.execSync + " " + (m.execSync ? String(m.execSync("echo pwned")) : ""); });
  await t("raw socket to the host", async () => { const { connect } = await import("cloudflare:sockets"); const s = connect({ hostname: "127.0.0.1", port: e.externalPort }); const w = s.writable.getWriter(); await w.write(new TextEncoder().encode("GET /ok HTTP/1.0\\r\\n\\r\\n")); const rd = s.readable.getReader(); const { value } = await rd.read(); return "CONNECTED: " + new TextDecoder().decode(value).slice(0, 40); });
  await t("node:http request to the loopback", async () => { const h = await import("node:http"); return await new Promise((res, rej) => { const q = h.request({ host: "127.0.0.1", port: e.externalPort, path: "/ok" }, (s) => { let d = ""; s.on("data", (c) => (d += c)); s.on("end", () => res("GOT " + d)); }); q.on("error", rej); q.end(); setTimeout(() => rej(new Error("timeout 2s")), 2000); }); });
  return r;
} } };`,
  },
};
