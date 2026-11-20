// A place to publish to over SFTP (spec 10, section 7.2): classic hosting. The server's host key is checked against the
// fingerprint the owner confirmed, so a different machine answering at the same address is refused; each file is written
// under a temporary name and renamed, so a visitor never gets half a file; and every failure is said in plain words.
import { createHash } from "node:crypto";
import { Client, type SFTPWrapper } from "ssh2";
import { MANIFEST_FILE, isSafePath, type Manifest, type PublishTarget } from "./publish.js";

export interface SftpOptions {
  host: string;
  port: number;
  username: string;
  /** The folder on the server the site goes in (absolute, or relative to the account's home folder). */
  remoteDir: string;
  /** The fingerprint of the server's host key that the owner confirmed: `SHA256:` and 43 characters. */
  hostKey: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** How long to wait for the connection, in milliseconds. */
  timeoutMs?: number;
}

/** The fingerprint of a host key, written the way OpenSSH writes it (`ssh-keygen -l`). */
export const fingerprintOf = (key: Buffer): string =>
  `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

/** What went wrong, in plain words, from what the connection library said. */
export function plainSftpError(error: unknown, o: { host: string; port: number }): string {
  const text = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  if (/All configured authentication methods failed|Authentication failed/i.test(text))
    return "The server refused the user name, the password or the key.";
  if (/Host denied|verification failed|Handshake failed/i.test(text))
    return "The server's host key is not the one you confirmed, so the connection was stopped. If the server was changed on purpose, check it again and save the new fingerprint.";
  if (code === "ECONNREFUSED")
    return `Nothing answered at ${o.host}:${o.port} (the connection was refused).`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `The name ${o.host} could not be found.`;
  if (code === "ETIMEDOUT" || /timed out|Timed out/i.test(text))
    return `${o.host}:${o.port} did not answer in time.`;
  if (
    /passphrase|Encrypted private key|Malformed|Unsupported key|Cannot parse privateKey/i.test(text)
  )
    return "The private key could not be read (a wrong passphrase, or a key in a format that is not supported).";
  if (/No such file|no such file/i.test(text) || code === "2")
    return "A folder or file was not found on the server.";
  if (/Permission denied|permission denied/i.test(text) || code === "3")
    return "The server did not allow that: the account may not write in this folder.";
  return text.slice(0, 200);
}

/** Connects only to learn the fingerprint of the server's host key, for the owner to check and confirm. */
export async function probeSftpHost(
  host: string,
  port: number,
  timeoutMs = 10_000,
): Promise<{ ok: true; fingerprint: string } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    const client = new Client();
    let fingerprint = "";
    let done = false;
    const finish = (result: { ok: true; fingerprint: string } | { ok: false; message: string }) => {
      if (done) return;
      done = true;
      client.end();
      client.destroy();
      resolve(result);
    };
    client.on("error", (error) => {
      // Refusing the key ends the connection with an error: what was wanted (the fingerprint) is already known.
      if (fingerprint) finish({ ok: true, fingerprint });
      else finish({ ok: false, message: plainSftpError(error, { host, port }) });
    });
    client.on("close", () => {
      if (fingerprint) finish({ ok: true, fingerprint });
      else
        finish({
          ok: false,
          message: `${host}:${port} closed the connection before it showed its key.`,
        });
    });
    try {
      client.connect({
        host,
        port,
        username: "oks-check",
        readyTimeout: timeoutMs,
        hostVerifier: (key: Buffer) => {
          fingerprint = fingerprintOf(key);
          return false;
        },
      });
    } catch (error) {
      finish({ ok: false, message: plainSftpError(error, { host, port }) });
    }
  });
}

const call = <T>(
  run: (done: (error: Error | null | undefined, value?: T) => void) => void,
): Promise<T> =>
  new Promise((resolve, reject) => {
    try {
      run((error, value) => (error ? reject(error) : resolve(value as T)));
    } catch (error) {
      reject(error);
    }
  });

const missing = (error: unknown): boolean => {
  const e = error as { code?: unknown; message?: string } | null;
  return e?.code === 2 || e?.code === "ENOENT" || /No such file/i.test(e?.message ?? "");
};

/** A place on an SFTP server. The connection is made when it is first needed and closed when the publish is over. */
export function sftpTarget(o: SftpOptions): PublishTarget {
  const dir = o.remoteDir.replace(/\/+$/, "") || "/";
  const remote = (path: string): string => {
    if (!isSafePath(path)) throw new Error(`"${path}" is not a safe file name`);
    return dir === "/" ? `/${path}` : `${dir}/${path}`;
  };
  let client: Client | null = null;
  let sftp: SFTPWrapper | null = null;
  let lost: Error | null = null;
  // An operation waiting for the server stops at once when the connection is lost, instead of waiting for ever.
  let rejectLost: (error: Error) => void = () => undefined;
  const lostSignal = new Promise<never>((_, reject) => {
    rejectLost = reject;
  });
  lostSignal.catch(() => undefined);
  const setLost = (error: Error) => {
    if (lost) return;
    lost = error;
    rejectLost(error);
  };
  const ask = <T>(
    run: (done: (error: Error | null | undefined, value?: T) => void) => void,
  ): Promise<T> => Promise.race([call<T>(run), lostSignal]);
  const made = new Set<string>();

  async function connection(): Promise<SFTPWrapper> {
    if (lost) throw lost;
    if (sftp) return sftp;
    const c = new Client();
    client = c;
    return new Promise<SFTPWrapper>((resolve, reject) => {
      c.on("error", (error) => {
        setLost(new Error(plainSftpError(error, o)));
        reject(lost);
      });
      c.on("close", () => {
        setLost(new Error("The connection to the server was lost."));
      });
      c.on("ready", () => {
        c.sftp((error, opened) => {
          if (error) {
            setLost(new Error(plainSftpError(error, o)));
            reject(lost);
          } else {
            sftp = opened;
            opened.on("close", () => {
              setLost(new Error("The connection to the server was lost."));
            });
            resolve(opened);
          }
        });
      });
      try {
        c.connect({
          host: o.host,
          port: o.port,
          username: o.username,
          ...(o.password !== undefined ? { password: o.password } : {}),
          ...(o.privateKey !== undefined ? { privateKey: o.privateKey } : {}),
          ...(o.passphrase !== undefined ? { passphrase: o.passphrase } : {}),
          readyTimeout: o.timeoutMs ?? 20_000,
          hostVerifier: (key: Buffer) => fingerprintOf(key) === o.hostKey,
        });
      } catch (error) {
        setLost(new Error(plainSftpError(error, o)));
        reject(lost);
      }
    });
  }

  /** Makes the folders of a path, one level at a time, once each. */
  async function mkdirp(s: SFTPWrapper, folder: string): Promise<void> {
    const parts = folder.split("/");
    let at = folder.startsWith("/") ? "" : ".";
    for (const part of parts) {
      if (part === "") continue;
      at = at === "" ? `/${part}` : at === "." ? part : `${at}/${part}`;
      if (made.has(at)) continue;
      try {
        await ask<unknown>((done) => s.stat(at, done));
      } catch (error) {
        if (!missing(error)) throw error;
        await ask<void>((done) => s.mkdir(at, done));
      }
      made.add(at);
    }
  }

  async function rename(s: SFTPWrapper, from: string, to: string): Promise<void> {
    const open = s as SFTPWrapper & {
      ext_openssh_rename?: (a: string, b: string, cb: (e?: Error | null) => void) => void;
    };
    // The OpenSSH way replaces the old file in one step; others refuse an existing name, so the old one is removed first.
    if (typeof open.ext_openssh_rename === "function") {
      try {
        await ask<void>((done) => open.ext_openssh_rename!(from, to, done));
        return;
      } catch {
        // not supported by this server: use the plain way
      }
    }
    try {
      await ask<void>((done) => s.rename(from, to, done));
    } catch {
      await ask<void>((done) => s.unlink(to, done)).catch(() => undefined);
      await ask<void>((done) => s.rename(from, to, done));
    }
  }

  async function writeWhole(s: SFTPWrapper, path: string, bytes: Buffer): Promise<void> {
    const slash = path.lastIndexOf("/");
    if (slash > 0) await mkdirp(s, path.slice(0, slash));
    const temp = `${path}.oks-part`;
    await ask<void>((done) => s.writeFile(temp, bytes, done));
    await rename(s, temp, path);
  }

  return {
    async previous() {
      const s = await connection();
      try {
        const text = (
          await ask<Buffer>((done) => s.readFile(remote(MANIFEST_FILE), done))
        ).toString("utf8");
        const m = JSON.parse(text) as Manifest;
        return m.v === 1 && m.files && typeof m.files === "object" ? m : null;
      } catch (error) {
        if (missing(error) || error instanceof SyntaxError) return null;
        throw new Error(plainSftpError(error, o), { cause: error });
      }
    },
    async put(path, bytes) {
      const s = await connection();
      try {
        await writeWhole(s, remote(path), bytes);
      } catch (error) {
        throw new Error(lost?.message ?? plainSftpError(error, o), { cause: error });
      }
    },
    async remove(path) {
      const s = await connection();
      try {
        await ask<void>((done) => s.unlink(remote(path), done));
      } catch (error) {
        if (!missing(error))
          throw new Error(lost?.message ?? plainSftpError(error, o), { cause: error });
      }
    },
    async finish(manifest) {
      const s = await connection();
      try {
        await mkdirp(s, dir);
        await writeWhole(s, remote(MANIFEST_FILE), Buffer.from(JSON.stringify(manifest)));
      } catch (error) {
        throw new Error(lost?.message ?? plainSftpError(error, o), { cause: error });
      }
    },
    async close() {
      client?.end();
      client?.destroy();
      client = null;
      sftp = null;
    },
  };
}
