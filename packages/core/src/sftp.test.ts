// SFTP publishing (spec 10, section 7.2; ST-32), against a small SFTP server that runs inside the test: the files of a site
// arrive whole, only changes are sent, a wrong key or password stops the connection with a plain sentence, and a cut
// connection leaves the place as it was and is finished by the next publish.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { MANIFEST_FILE, publishSite } from "./publish.js";
import { plainSftpError, probeSftpHost, sftpTarget } from "./sftp.js";
import {
  TEST_HOST_KEY as hostKey,
  TEST_PASSWORD,
  startSftpServer as startServer,
} from "./testing/sftp-server.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const site = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "oks-sftp-site-"));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};

const options = (port: number, over: Record<string, unknown> = {}) => ({
  host: "127.0.0.1",
  port,
  username: "ada",
  password: TEST_PASSWORD,
  remoteDir: "/var/www/site",
  hostKey,
  timeoutMs: 5000,
  ...over,
});

describe("an SFTP place", { timeout: 90_000 }, () => {
  test("the server's host key is learned for the owner to confirm", async () => {
    const server = await startServer();
    try {
      expect(await probeSftpHost("127.0.0.1", server.port, 5000)).toEqual({
        ok: true,
        fingerprint: hostKey,
      });
      expect(hostKey).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    } finally {
      await server.close();
    }
  });

  test("a first publish sends every file, a second only what changed, and files that are gone are removed", async () => {
    const server = await startServer();
    try {
      const dir = site({
        "index.html": "<p>home</p>",
        "about/index.html": "<p>about</p>",
        "style.css": "css",
      });
      const first = await publishSite(dir, sftpTarget(options(server.port)));
      expect(first).toMatchObject({ ok: true, planned: 3 });
      expect(server.text("/var/www/site/about/index.html")).toBe("<p>about</p>");
      expect(server.text(`/var/www/site/${MANIFEST_FILE}`)).toContain("about/index.html");
      // Nothing half-written stays on the server.
      expect([...server.files.keys()].filter((p) => p.endsWith(".oks-part"))).toEqual([]);

      server.log.length = 0;
      writeFileSync(join(dir, "index.html"), "<p>home 2</p>");
      rmSync(join(dir, "style.css"));
      const second = await publishSite(dir, sftpTarget(options(server.port)));
      expect(second).toMatchObject({ ok: true, planned: 2 });
      // The server refuses a rename onto an existing file: the new file still replaces the old one.
      expect(server.text("/var/www/site/index.html")).toBe("<p>home 2</p>");
      expect(server.files.has("/var/www/site/style.css")).toBe(false);
      expect(server.log.filter((l) => l.startsWith("write")).length).toBe(2); // the page and the record
      expect((await publishSite(dir, sftpTarget(options(server.port)))).planned).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("a wrong password and a different host key stop the connection with a plain sentence, and nothing is sent", async () => {
    const server = await startServer();
    try {
      const dir = site({ "index.html": "x" });
      const badPassword = await publishSite(
        dir,
        sftpTarget(options(server.port, { password: "nope" })),
      );
      expect(badPassword.ok).toBe(false);
      expect(badPassword.problem).toMatch(/refused the user name, the password or the key/);
      const otherKey = `SHA256:${"A".repeat(43)}`;
      const badKey = await publishSite(
        dir,
        sftpTarget(options(server.port, { hostKey: otherKey })),
      );
      expect(badKey.ok).toBe(false);
      expect(badKey.problem).toMatch(/host key is not the one you confirmed/);
      expect(server.files.size).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("a server that nobody answers for is a plain sentence", async () => {
    const server = await startServer();
    const port = server.port;
    await server.close();
    const report = await publishSite(site({ "index.html": "x" }), sftpTarget(options(port)));
    expect(report.ok).toBe(false);
    expect(report.problem).toMatch(/Nothing answered at 127\.0\.0\.1:/);
    const probe = await probeSftpHost("127.0.0.1", port, 3000);
    expect(probe.ok).toBe(false);
  });

  test("a cut connection leaves the place as it was, and the next publish finishes the job", async () => {
    const server = await startServer({ dropAfterWrites: 2 });
    try {
      const dir = site({ "a.css": "a", "b.js": "b", "index.html": "i", "about/index.html": "j" });
      const cut = await publishSite(dir, sftpTarget(options(server.port)));
      expect(cut.ok).toBe(false);
      expect(cut.problem).toMatch(/lost|failed/);
      // The record was not written, and the pages (sent after the other files) did not arrive.
      expect(server.files.has(`/var/www/site/${MANIFEST_FILE}`)).toBe(false);
      expect(server.files.has("/var/www/site/index.html")).toBe(false);
      // The place is back: the next publish finishes what was missing and writes the record.
      const again = await publishSite(dir, sftpTarget(options(server.port)));
      expect(again.ok).toBe(true);
      expect(server.text("/var/www/site/index.html")).toBe("i");
      expect(server.text("/var/www/site/about/index.html")).toBe("j");
      expect(server.files.has(`/var/www/site/${MANIFEST_FILE}`)).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("a file name that is not safe is refused before anything is sent", async () => {
    const server = await startServer();
    try {
      const target = sftpTarget(options(server.port));
      await expect(target.put("../escape", Buffer.from("x"))).rejects.toThrow(/not a safe/);
      await target.close?.();
    } finally {
      await server.close();
    }
  });

  test("the plain sentences for what can go wrong", () => {
    const where = { host: "h.example", port: 22 };
    expect(plainSftpError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }), where)).toMatch(
      /refused/,
    );
    expect(plainSftpError(Object.assign(new Error("x"), { code: "ENOTFOUND" }), where)).toMatch(
      /could not be found/,
    );
    expect(plainSftpError(new Error("Timed out while waiting for handshake"), where)).toMatch(
      /did not answer in time/,
    );
    expect(
      plainSftpError(new Error("Cannot parse privateKey: Unsupported key format"), where),
    ).toMatch(/private key could not be read/);
    expect(plainSftpError(new Error("Permission denied"), where)).toMatch(/may not write/);
  });
});
