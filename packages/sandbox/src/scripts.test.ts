// PL-42: an interactive block's script is served from the site's own origin, and only for a plugin that is on and has the
// `site:scripts` permission; the content security policy allows the site itself and nothing else. The scripts are
// served for real over HTTP. (A check of the policy in a real browser is still to do, see spec 04, open item 7.)
import { openSqlite, type TestDb } from "@oks-page/db/testing";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxHost } from "./host.js";
import {
  contentSecurityPolicy,
  PluginScripts,
  SCRIPT_PERMISSION,
  SCRIPT_PREFIX,
} from "./scripts.js";

const CART = `document.querySelectorAll("[data-cart]").forEach((el) => el.addEventListener("click", () => {}));`;
const SPY = `fetch("/steal");`;
const ext = (key: string) =>
  `EXT${key
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .padEnd(23, "0")}`.slice(0, 26);

describe("PL-42 scripts of interactive blocks", () => {
  let db: TestDb;
  let host: SandboxHost;
  let scripts: PluginScripts;
  let server: Server;
  let base = "";

  beforeAll(async () => {
    db = await openSqlite();
    host = new SandboxHost({
      runner: db.runner,
      siteId: "SITE0000000000000000000042",
      content: { get: async () => null, update: async () => null },
      workDir: "/tmp",
    });
    const noop = "export default {};";
    host.load(
      { id: "shop-cart", version: "1.0.0", permissions: [SCRIPT_PERMISSION] },
      noop,
      ext("shop-cart"),
    );
    host.load(
      { id: "no-scripts", version: "1.0.0", permissions: ["content:read"] },
      noop,
      ext("no-scripts"),
    );
    host.load(
      { id: "switched-off", version: "1.0.0", permissions: [SCRIPT_PERMISSION] },
      noop,
      ext("switched-off"),
    );
    scripts = new PluginScripts((id) => host.isAllowed(id, SCRIPT_PERMISSION));
    scripts.add("shop-cart", [{ path: "islands/cart.js", source: CART }]);
    scripts.add("no-scripts", [{ path: "spy.js", source: SPY }]);
    scripts.add("switched-off", [{ path: "late.js", source: CART }]);
    host.disable("switched-off");
    server = createServer((req, res) => {
      const r = scripts.serve(req.url ?? "");
      res.writeHead(r.status, r.headers);
      res.end(r.body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    server?.close();
    await host?.close();
    await db?.close();
  });

  test("PL-42 a script of a plugin with site:scripts is served from the site's own address, over real HTTP", async () => {
    const url = scripts.url("shop-cart", "islands/cart.js")!;
    expect(url).toMatch(
      new RegExp(`^${SCRIPT_PREFIX}shop-cart/islands/cart\\.js\\?v=[0-9a-f]{16}$`),
    );
    const r = await fetch(base + url);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await r.text()).toBe(CART);
  });

  test("PL-42 a plugin without site:scripts gets no tag and its script is not served, even though it was added", async () => {
    expect(scripts.tags(["no-scripts"])).toEqual([]);
    const r = await fetch(`${base}${SCRIPT_PREFIX}no-scripts/spy.js`);
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("Not found");
  });

  test("PL-42 a plugin that is switched off, and one that does not exist, get the same plain 404", async () => {
    const off = await fetch(`${base}${SCRIPT_PREFIX}switched-off/late.js`);
    const none = await fetch(`${base}${SCRIPT_PREFIX}nobody-here/late.js`);
    expect([off.status, none.status]).toEqual([404, 404]);
    expect(await off.text()).toBe(await none.text());
    expect(scripts.tags(["switched-off", "nobody-here"])).toEqual([]);
  });

  test("PL-42 the tag loads the script from the site's own address with its hash, and only for plugins that are allowed", () => {
    const tags = scripts.tags(["shop-cart", "no-scripts", "switched-off"]);
    expect(tags).toHaveLength(1);
    const hash = createHash("sha256").update(CART).digest("base64");
    expect(tags[0]).toContain(`integrity="sha256-${hash}"`);
    expect(tags[0]).toContain('src="/_oks/plugins/shop-cart/islands/cart.js?v=');
    expect(tags[0]).not.toMatch(/src="(https?:)?\/\//);
  });

  test("PL-42 tricks with the path never reach a file: dots, slashes, encoding, other plugins' files, other kinds of file", async () => {
    for (const bad of [
      "shop-cart/../no-scripts/spy.js",
      "shop-cart/%2e%2e/no-scripts/spy.js",
      "shop-cart//islands/cart.js",
      "shop-cart/islands/cart.json",
      "shop-cart/islands/CART.js",
      "shop-cart\\islands\\cart.js",
      "no-scripts/islands/cart.js",
      "shop-cart/",
      "shop-cart",
      "..%2fno-scripts/spy.js",
    ])
      expect(scripts.serve(SCRIPT_PREFIX + bad).status, bad).toBe(404);
    expect(scripts.serve("/other/shop-cart/islands/cart.js").status).toBe(404);
  });

  test("PL-42 a path that could climb out of the plugin's folder is refused when the plugin is added", () => {
    for (const path of [
      "../x.js",
      "/etc/x.js",
      "a//b.js",
      "a/../b.js",
      "x.html",
      ".hidden.js",
      "a\\b.js",
      "x.js\0",
    ])
      expect(() => scripts.add("shop-cart", [{ path, source: "" }]), path).toThrow(
        /not an allowed script path/,
      );
    expect(() => scripts.add("Bad Id", [])).toThrow(/not a valid plugin id/);
  });

  test("PL-42 the address carries the version: the current one is cached for good, a stale one is not", () => {
    expect(
      scripts.serve(scripts.url("shop-cart", "islands/cart.js")!).headers["cache-control"],
    ).toMatch(/immutable/);
    expect(
      scripts.serve(`${SCRIPT_PREFIX}shop-cart/islands/cart.js?v=0000000000000000`).headers[
        "cache-control"
      ],
    ).toBe("no-cache");
    expect(
      scripts.serve(`${SCRIPT_PREFIX}shop-cart/islands/cart.js`).headers["cache-control"],
    ).toBe("no-cache");
  });

  test("PL-42 the content security policy allows the site itself and nothing else", () => {
    const policy = contentSecurityPolicy();
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|strict-dynamic/);
    expect(policy).not.toMatch(/https?:|\*/);
    const scriptSrc = policy.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(scriptSrc).toBe("script-src 'self'");
  });

  test("PL-42 taking the permission away stops the script at once", async () => {
    host.load(
      { id: "shop-cart", version: "1.0.1", permissions: ["content:read"] },
      "export default {};",
      ext("shop-cart"),
    );
    expect(scripts.tags(["shop-cart"])).toEqual([]);
    expect((await fetch(base + scripts.url("shop-cart", "islands/cart.js")!)).status).toBe(404);
  });
});
