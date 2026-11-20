// Getting a plugin file out of an npm package: a fake registry answers, so nothing leaves this computer.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { fetchPluginFromNpm, findInTar } from "./npm-package.js";
import { makePluginFile, readPluginFile } from "./plugin-file.js";

/** A tar archive of plain files, like the one `npm pack` makes. */
function tarOf(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100, "latin1");
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "latin1");
    header.write("0", 156, "latin1");
    header.write("ustar\0", 257, "latin1");
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const manifest = {
  id: "hello-plugin",
  version: "1.0.0",
  displayName: "Hello",
  description: "Says hello.",
  author: "Ada",
  permissions: ["content:read"],
  hooks: [],
  blocks: [],
};
const PLUGIN = JSON.stringify(makePluginFile(manifest, "export default { hooks: {} };"));

interface Fake {
  tarball?: Buffer;
  meta?: Record<string, unknown>;
  status?: number;
  tarballUrl?: string;
  length?: number;
}

/** A registry with one package. */
function registry(fake: Fake = {}) {
  const tarball =
    fake.tarball ??
    gzipSync(
      tarOf({ "package/hello-plugin-1.0.0.oksplugin": PLUGIN, "package/package.json": "{}" }),
    );
  const url = fake.tarballUrl ?? "https://registry.example/hello-plugin/-/hello-plugin-1.0.0.tgz";
  const meta = {
    name: "hello-plugin",
    version: "1.0.0",
    dist: {
      tarball: url,
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      shasum: createHash("sha1").update(tarball).digest("hex"),
    },
    ...fake.meta,
  };
  const asked: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const address = String(input);
    asked.push(address);
    if (fake.status) return new Response("no", { status: fake.status });
    if (address.endsWith(".tgz"))
      return new Response(new Uint8Array(tarball), {
        headers: { "content-length": String(fake.length ?? tarball.length) },
      });
    return new Response(JSON.stringify(meta));
  }) as typeof fetch;
  return { impl, asked };
}

const get = (name: string, version: string, fake?: Fake) => {
  const r = registry(fake);
  return fetchPluginFromNpm(name, version, {
    registry: "https://registry.example",
    fetchImpl: r.impl,
  }).then((result) => ({ result, asked: r.asked }));
};

describe("a plugin from npm", () => {
  test("the plugin file is read out of the package, and it is a valid plugin file", async () => {
    const { result, asked } = await get("hello-plugin", "");
    expect(result).toMatchObject({ ok: true, name: "hello-plugin", version: "1.0.0" });
    expect(result.ok && readPluginFile(result.text).ok).toBe(true);
    // The latest version was asked for by name, and then the tarball from the same host.
    expect(asked).toEqual([
      "https://registry.example/hello-plugin/latest",
      "https://registry.example/hello-plugin/-/hello-plugin-1.0.0.tgz",
    ]);
    // A version and a scoped name are put in the address in the way the registry reads them.
    const scoped = registry({ meta: { name: "@ada/hello" } });
    await fetchPluginFromNpm("@ada/hello", "1.0.0", {
      registry: "https://registry.example/",
      fetchImpl: scoped.impl,
    });
    expect(scoped.asked[0]).toBe("https://registry.example/@ada%2Fhello/1.0.0");
  });

  test("a name or version that cannot be an npm package is refused before anything is asked", async () => {
    for (const name of ["", "Has Space", "../x", "a".repeat(215), "@/x", "UPPER"]) {
      const { result, asked } = await get(name, "");
      expect(result).toMatchObject({ ok: false });
      expect(asked).toEqual([]);
    }
    expect((await get("hello-plugin", "latest; rm")).result).toMatchObject({ ok: false });
  });

  test("a missing package, a registry error and a redirect are plain messages", async () => {
    expect((await get("hello-plugin", "", { status: 404 })).result).toEqual({
      ok: false,
      message: "There is no such package or version on npm.",
    });
    expect((await get("hello-plugin", "", { status: 500 })).result).toMatchObject({ ok: false });
    const redirecting = (async () => {
      throw new TypeError("redirect");
    }) as unknown as typeof fetch;
    expect(
      await fetchPluginFromNpm("hello-plugin", "", {
        registry: "https://registry.example",
        fetchImpl: redirecting,
      }),
    ).toEqual({ ok: false, message: "The npm registry could not be reached." });
  });

  test("a download that does not match the registry's hash is not used, and a package with no hash is not used", async () => {
    const tarball = gzipSync(tarOf({ "package/x.oksplugin": PLUGIN }));
    const changed = await get("hello-plugin", "", {
      tarball,
      meta: {
        dist: { tarball: "https://registry.example/a.tgz", integrity: "sha512-AAAA", shasum: "" },
      },
    });
    expect(changed.result).toMatchObject({ ok: false });
    expect(!changed.result.ok && changed.result.message).toMatch(/does not match the hash/);
    const noHash = await get("hello-plugin", "", {
      tarball,
      meta: { dist: { tarball: "https://registry.example/a.tgz" } },
    });
    expect(!noHash.result.ok && noHash.result.message).toMatch(/no hash/);
  });

  test("a tarball on another host and an answer for another package are not used", async () => {
    const other = await get("hello-plugin", "", { tarballUrl: "https://evil.example/a.tgz" });
    expect(!other.result.ok && other.result.message).toMatch(/another host/);
    expect(other.asked).toHaveLength(1);
    const wrongName = await get("hello-plugin", "", { meta: { name: "something-else" } });
    expect(wrongName.result).toMatchObject({ ok: false });
  });

  test("a package with no plugin file, with two, or one that is too big is refused", async () => {
    const none = await get("hello-plugin", "", {
      tarball: gzipSync(tarOf({ "package/package.json": "{}" })),
    });
    expect(!none.result.ok && none.result.message).toMatch(/oks pack/);
    const two = await get("hello-plugin", "", {
      tarball: gzipSync(tarOf({ "package/a.oksplugin": PLUGIN, "package/b.oksplugin": PLUGIN })),
    });
    expect(!two.result.ok && two.result.message).toMatch(/more than one/);
    // A plugin file deeper in the package is not taken.
    const deep = await get("hello-plugin", "", {
      tarball: gzipSync(tarOf({ "package/dist/a.oksplugin": PLUGIN })),
    });
    expect(deep.result).toMatchObject({ ok: false });
    const big = await get("hello-plugin", "", { length: 11 * 1024 * 1024 });
    expect(!big.result.ok && big.result.message).toMatch(/bigger than the limit/);
  });

  test("the tar reader finds a plain file and ignores directories", () => {
    const tar = tarOf({ "package/a.txt": "one", "package/b.oksplugin": "two" });
    expect(findInTar(tar, (p) => p.endsWith(".oksplugin"))?.toString()).toBe("two");
    expect(findInTar(tar, (p) => p.endsWith(".nothing"))).toBeNull();
    expect(findInTar(Buffer.alloc(10), () => true)).toBeNull();
  });
});
