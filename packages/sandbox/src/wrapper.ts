// The code that runs inside the plugin's own workerd process, around the plugin's bundle. It gives the plugin its
// `ctx` (every call goes to the host over HTTP, with the plugin's own token) and turns a hook or block call from the
// host into a call of the plugin's function.
export const WRAPPER_SOURCE = `import plugin from "plugin.js";
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
function makeCtx(env) {
  const call = async (p, data) => {
    const r = await fetch("http://host" + p, { method: "POST", headers: { "x-plugin-token": env.TOKEN, "content-type": "application/json" }, body: JSON.stringify(data ?? {}) });
    let j;
    try { j = await r.json(); } catch { j = { error: "bad host answer" }; }
    if (!r.ok) { const e = new Error(j.error || "host refused"); e.code = j.code; throw e; }
    return j.result;
  };
  return {
    content: { get: (id) => call("/content/get", { id }), update: (id, patch) => call("/content/update", { id, patch }) },
    storage: { get: (c, k) => call("/storage/get", { c, k }), set: (c, k, v) => call("/storage/set", { c, k, v }) },
    settings: { get: (k) => call("/settings/get", { k }) },
    http: { fetch: (url, init) => call("/http/fetch", { url, init }) },
    log: (m) => call("/log", { m }),
  };
}
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    const ctx = makeCtx(env);
    try {
      if (u.pathname.startsWith("/hook/")) {
        const fn = plugin.hooks?.[decodeURIComponent(u.pathname.slice(6))];
        if (!fn) return J({ ok: true, skipped: true });
        return J({ ok: true, result: await fn(body.event, ctx) });
      }
      if (u.pathname.startsWith("/block/")) {
        const b = plugin.blocks?.[decodeURIComponent(u.pathname.slice(7))];
        if (!b) return J({ ok: false, error: "no such block" }, 404);
        return J({ ok: true, result: await b.render(body.props, ctx) });
      }
      return J({ ok: false, error: "unknown route" }, 404);
    } catch (e) {
      return J({ ok: false, error: String((e && e.message) || e).slice(0, 300), code: e && e.code }, 200);
    }
  },
};
`;
