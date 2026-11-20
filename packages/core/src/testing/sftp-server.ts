// A small SFTP server for tests: the files are kept in memory, a rename onto an existing file is refused (like many real
// servers), and the connection can be cut after some files were written. It listens on the loopback address only.
import type { AddressInfo } from "node:net";
import { Server, utils } from "ssh2";
import { fingerprintOf } from "../sftp.js";

const { OPEN_MODE, STATUS_CODE } = utils.sftp;

interface ServerSftp {
  on(event: string, handler: (...args: never[]) => void): void;
  status(id: number, code: number): void;
  handle(id: number, handle: Buffer): void;
  data(id: number, data: Buffer): void;
  attrs(id: number, attrs: Record<string, number>): void;
}

const keys = utils.generateKeyPairSync("ed25519");
const parsed = utils.parseKey(keys.private);
if (parsed instanceof Error || Array.isArray(parsed))
  throw new Error("the test key could not be read");

/** The fingerprint of the test server's host key, as the owner would be shown it. */
export const TEST_HOST_KEY = fingerprintOf(parsed.getPublicSSH());
export const TEST_USER = "ada";
export const TEST_PASSWORD = "hunter2-publish-pass";

export interface TestSftpServer {
  port: number;
  files: Map<string, Buffer>;
  dirs: Set<string>;
  log: string[];
  text(path: string): string | undefined;
  close(): Promise<void>;
}

/** `dropAfterWrites`: the connection is cut once, after that many files were written. */
export async function startSftpServer(
  options: { dropAfterWrites?: number } = {},
): Promise<TestSftpServer> {
  let drop = options.dropAfterWrites;
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>(["/"]);
  let written = 0;
  const log: string[] = [];
  const server = new Server({ hostKeys: [keys.private] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === TEST_USER && ctx.password === TEST_PASSWORD)
        ctx.accept();
      else ctx.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        accept().on("sftp", (acceptSftp) => {
          const sftp = acceptSftp() as unknown as ServerSftp;
          const open = new Map<string, { path: string; write: boolean; data: Buffer }>();
          let next = 0;
          const on = <A extends unknown[]>(event: string, handler: (...args: A) => void) =>
            sftp.on(event, handler as unknown as (...args: never[]) => void);
          on("OPEN", (id: number, path: string, flags: number) => {
            const write = (flags & OPEN_MODE.WRITE) !== 0;
            if (!write && !files.has(path)) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
            const handle = Buffer.from(String(++next));
            open.set(handle.toString(), {
              path,
              write,
              data: write ? Buffer.alloc(0) : files.get(path)!,
            });
            sftp.handle(id, handle);
          });
          on("WRITE", (id: number, handle: Buffer, offset: number, data: Buffer) => {
            const h = open.get(handle.toString())!;
            const grown = Buffer.alloc(Math.max(h.data.length, offset + data.length));
            h.data.copy(grown);
            data.copy(grown, offset);
            h.data = grown;
            sftp.status(id, STATUS_CODE.OK);
          });
          on("FSTAT", (id: number, handle: Buffer) => {
            const h = open.get(handle.toString())!;
            sftp.attrs(id, {
              mode: 0o100644,
              size: h.data.length,
              uid: 0,
              gid: 0,
              atime: 0,
              mtime: 0,
            });
          });
          on("READ", (id: number, handle: Buffer, offset: number, length: number) => {
            const h = open.get(handle.toString())!;
            if (offset >= h.data.length) return sftp.status(id, STATUS_CODE.EOF);
            sftp.data(id, h.data.subarray(offset, offset + length));
          });
          on("CLOSE", (id: number, handle: Buffer) => {
            const h = open.get(handle.toString());
            open.delete(handle.toString());
            if (h?.write) {
              files.set(h.path, h.data);
              written++;
              log.push(`write ${h.path}`);
            }
            sftp.status(id, STATUS_CODE.OK);
            // Cut once: the connection is dropped after that many files, then the server behaves.
            if (drop !== undefined && written >= drop) {
              drop = undefined;
              setTimeout(() => client.end(), 0);
            }
          });
          const stat = (id: number, path: string) => {
            if (dirs.has(path))
              return sftp.attrs(id, {
                mode: 0o40755,
                size: 0,
                uid: 0,
                gid: 0,
                atime: 0,
                mtime: 0,
              });
            const f = files.get(path);
            if (!f) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
            sftp.attrs(id, {
              mode: 0o100644,
              size: f.length,
              uid: 0,
              gid: 0,
              atime: 0,
              mtime: 0,
            });
          };
          on("STAT", stat);
          on("LSTAT", stat);
          on("MKDIR", (id: number, path: string) => {
            if (dirs.has(path)) return sftp.status(id, STATUS_CODE.FAILURE);
            dirs.add(path);
            log.push(`mkdir ${path}`);
            sftp.status(id, STATUS_CODE.OK);
          });
          on("REMOVE", (id: number, path: string) => {
            if (!files.delete(path)) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
            log.push(`remove ${path}`);
            sftp.status(id, STATUS_CODE.OK);
          });
          on("RENAME", (id: number, from: string, to: string) => {
            const f = files.get(from);
            if (!f) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
            if (files.has(to)) return sftp.status(id, STATUS_CODE.FAILURE);
            files.delete(from);
            files.set(to, f);
            log.push(`rename ${to}`);
            sftp.status(id, STATUS_CODE.OK);
          });
        });
      });
    });
    client.on("error", () => undefined);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    port: (server.address() as AddressInfo).port,
    files,
    dirs,
    log,
    text: (path) => files.get(path)?.toString("utf8"),
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
