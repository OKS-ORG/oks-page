// The sandbox host (spec 04, section 5): one workerd process per plugin, a host API they call with their own token,
// a watchdog that kills a stuck plugin, and a count of failures that switches a plugin off.
import { newId, type SqlRunner } from "@oks-page/db";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import {
  createMemoryCap,
  detectMemoryLimit,
  type MemoryCap,
  type MemoryLimitSupport,
} from "./cgroup.js";
import { FetchRefused, safeFetch } from "./safe-fetch.js";
import type {
  CallKind,
  CallResult,
  ContentService,
  OwnerNotice,
  PluginManifest,
  PluginStatus,
} from "./types.js";
import { WRAPPER_SOURCE } from "./wrapper.js";

const require = createRequire(import.meta.url);
const WORKERD: string = (require("workerd") as { default: string }).default;

/** Which permission each host route needs. `null`: no permission needed (a plugin's own storage, settings and log). */
const ROUTE_PERMISSION: Record<string, string | null> = {
  "/content/get": "content:read",
  "/content/update": "content:write",
  "/storage/get": null,
  "/storage/set": null,
  "/settings/get": null,
  "/log": null,
  "/http/fetch": "network:fetch",
};

export interface HostOptions {
  runner: SqlRunner;
  siteId: string;
  content: ContentService;
  settings?: (pluginId: string, key: string) => Promise<unknown>;
  /** A folder for each plugin's files. */
  workDir: string;
  /** A call that takes longer than this is stopped and the process killed. */
  wallMs?: number;
  /** This many failures within the window switch the plugin off. */
  maxFailures?: number;
  failureWindowMs?: number;
  /** A plugin's own storage may not grow beyond this (spec 04: 10 MB to start). */
  storageLimitBytes?: number;
  /** A cap for each plugin process, in megabytes, where the system can enforce it. 0: none. */
  memoryMb?: number;
  /** A process that has had no call for this long is stopped (it starts again on the next call). 0: never. */
  idleMs?: number;
  /** Tests only. */
  allowPrivateForTests?: boolean;
  /** Tests only: pretend the system cannot cap memory. */
  pretendNoMemoryLimit?: boolean;
}

interface Loaded {
  manifest: PluginManifest;
  extensionId: string;
  code: string;
  codeHash: string;
  token: Buffer;
  tokenHex: string;
  port: number;
  proc: ChildProcess | null;
  cap: MemoryCap | null;
  failures: number[];
  status: PluginStatus;
  startedMs: number;
  idleTimer: NodeJS.Timeout | null;
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createNetServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

export class SandboxHost {
  readonly notices: OwnerNotice[] = [];
  readonly memoryLimit: MemoryLimitSupport;
  private readonly plugins = new Map<string, Loaded>();
  private readonly byToken = new Map<string, Loaded>();
  private server: Server | null = null;
  private hostPort = 0;
  private readonly o: Required<
    Omit<HostOptions, "settings" | "runner" | "siteId" | "content" | "workDir">
  > &
    Pick<HostOptions, "settings" | "runner" | "siteId" | "content" | "workDir">;

  constructor(options: HostOptions) {
    this.o = {
      wallMs: 2000,
      maxFailures: 3,
      failureWindowMs: 60_000,
      storageLimitBytes: 10_000_000,
      memoryMb: 0,
      idleMs: 0,
      allowPrivateForTests: false,
      pretendNoMemoryLimit: false,
      ...options,
    };
    this.memoryLimit =
      this.o.memoryMb > 0 && !this.o.pretendNoMemoryLimit ? detectMemoryLimit() : "none";
  }

  /** A plain message for the admin when a memory cap was asked for and the system cannot give one (PL-32); otherwise null. */
  limitsNote(): string | null {
    if (this.o.memoryMb > 0 && this.memoryLimit === "none") {
      return "This server cannot limit the memory of a plugin, so plugins from the marketplace are switched off here. Plugins built into the site still work. Use the Docker image, or a server where the site runs with enough rights.";
    }
    return null;
  }

  async listen(): Promise<void> {
    this.server = createServer((req, res) => void this.onHostCall(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.hostPort = (this.server.address() as { port: number }).port;
  }

  async close(): Promise<void> {
    for (const p of this.plugins.values()) this.stop(p);
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  /** Make a plugin known. `extensionId` is its row in the `extensions` table (its storage belongs to that row).
   * Calling this again for the same plugin id (an update or a rollback) stops the running process first, so
   * the old one is never left behind. */
  load(manifest: PluginManifest, code: string, extensionId: string): void {
    const existing = this.plugins.get(manifest.id);
    if (existing) this.stop(existing);
    const tokenBuf = randomBytes(16);
    const p: Loaded = {
      manifest,
      extensionId,
      code,
      codeHash: createHash("sha256").update(code).digest("hex"),
      token: tokenBuf,
      tokenHex: tokenBuf.toString("hex"),
      port: 0,
      proc: null,
      cap: null,
      failures: [],
      status: "enabled",
      startedMs: 0,
      idleTimer: null,
    };
    this.plugins.set(manifest.id, p);
    this.byToken.set(p.tokenHex, p);
  }

  /** The hash a bundle must have: stored with the installed plugin, and checked on every start (PL-23, PL-35). */
  static hashOf(code: string): string {
    return createHash("sha256").update(code).digest("hex");
  }

  /** Test helper: change the code on disk after loading, to see the integrity check refuse it. */
  tamper(id: string, newCode: string): void {
    this.plugins.get(id)!.code = newCode;
  }

  status(id: string): PluginStatus | "unknown" {
    return this.plugins.get(id)?.status ?? "unknown";
  }

  startMs(id: string): number {
    return this.plugins.get(id)?.startedMs ?? 0;
  }

  isRunning(id: string): boolean {
    const p = this.plugins.get(id);
    return Boolean(p?.proc && p.proc.exitCode === null);
  }

  pid(id: string): number | undefined {
    return this.plugins.get(id)?.proc?.pid;
  }

  // ---- calls into a plugin ----

  async call(id: string, kind: CallKind, name: string, payload: unknown): Promise<CallResult> {
    const started = performance.now();
    const ms = () => Math.round((performance.now() - started) * 100) / 100;
    const p = this.plugins.get(id);
    if (!p)
      return {
        ok: false,
        skipped: true,
        reason: "unknown plugin",
        error: "unknown plugin",
        ms: ms(),
      };
    if (p.status !== "enabled")
      return {
        ok: false,
        skipped: true,
        reason: p.status,
        error: `the plugin is ${p.status}`,
        ms: ms(),
      };
    // Integrity: a bundle whose bytes changed is not run (PL-23, PL-35).
    if (
      p.manifest.integrity &&
      p.manifest.integrity !== createHash("sha256").update(p.code).digest("hex")
    ) {
      await this.audit(p, "runner.integrity_failed", { name });
      return {
        ok: false,
        error: "the plugin's files have changed since it was installed",
        code: "integrity",
        ms: ms(),
      };
    }
    try {
      await this.start(p);
      this.touch(p);
      const response = await fetch(
        `http://127.0.0.1:${p.port}/${kind}/${encodeURIComponent(name)}`,
        {
          method: "POST",
          body: JSON.stringify(kind === "hook" ? { event: payload } : { props: payload }),
          signal: AbortSignal.timeout(this.o.wallMs),
        },
      );
      const body = (await response.json()) as {
        ok: boolean;
        result?: unknown;
        skipped?: boolean;
        error?: string;
        code?: string;
      };
      if (!body.ok && !body.skipped)
        await this.recordFailure(p, `error: ${body.error ?? "unknown"}`);
      return { ...body, ms: ms() } as CallResult;
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
      if (process.env.OKS_DEBUG_SANDBOX) console.error("[oks sandbox] call failed:", e);
      this.stop(p);
      await this.recordFailure(
        p,
        timedOut ? "timeout" : `crash: ${String((e as Error).message).slice(0, 60)}`,
      );
      return { ok: false, error: timedOut ? "timeout" : "crashed", killed: true, ms: ms() };
    }
  }

  private touch(p: Loaded) {
    if (p.idleTimer) clearTimeout(p.idleTimer);
    if (this.o.idleMs > 0) {
      p.idleTimer = setTimeout(() => this.stop(p), this.o.idleMs);
      p.idleTimer.unref();
    }
  }

  private async start(p: Loaded): Promise<void> {
    if (p.proc && p.proc.exitCode === null) return;
    p.port = await freePort(); // a new port each time: the old one may still be closing
    const dir = join(this.o.workDir, p.manifest.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "wrapper.js"), WRAPPER_SOURCE);
    writeFileSync(join(dir, "plugin.js"), p.code);
    writeFileSync(
      join(dir, "config.capnp"),
      `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = (
      modules = [(name = "wrapper.js", esModule = embed "wrapper.js"), (name = "plugin.js", esModule = embed "plugin.js")],
      compatibilityDate = "2026-10-01",
      bindings = [(name = "TOKEN", text = "${p.tokenHex}")],
      globalOutbound = "host")),
    (name = "host", external = (address = "127.0.0.1:${this.hostPort}", http = ()))
  ],
  sockets = [(name = "http", address = "127.0.0.1:${p.port}", http = (), service = "main")]
);`,
    );
    const t0 = performance.now();
    const proc = spawn(WORKERD, ["serve", join(dir, "config.capnp"), "--experimental"], {
      stdio: "ignore",
    });
    p.proc = proc;
    proc.on("exit", () => {
      if (p.proc === proc) p.proc = null;
    });
    if (this.o.memoryMb > 0) {
      p.cap?.remove();
      p.cap = createMemoryCap(this.memoryLimit, `${p.manifest.id}_${proc.pid}`, this.o.memoryMb);
      p.cap?.attach(proc.pid!);
    }
    for (let i = 0; i < 300; i++) {
      try {
        await fetch(`http://127.0.0.1:${p.port}/ping`, {
          method: "POST",
          body: "{}",
          signal: AbortSignal.timeout(300),
        });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    p.startedMs = Math.round(performance.now() - t0);
  }

  private stop(p: Loaded) {
    if (p.idleTimer) clearTimeout(p.idleTimer);
    p.idleTimer = null;
    if (p.proc) {
      try {
        p.proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      p.proc = null;
    }
    // The cap's folder can only be removed once the process has left it; try now and again shortly.
    const cap = p.cap;
    p.cap = null;
    if (cap) {
      const t = setInterval(() => {
        try {
          cap.remove();
          clearInterval(t);
        } catch {
          /* still busy */
        }
      }, 100);
      setTimeout(() => clearInterval(t), 3000).unref();
    }
  }

  private async recordFailure(p: Loaded, why: string) {
    const now = Date.now();
    p.failures = p.failures.filter((t) => now - t < this.o.failureWindowMs);
    p.failures.push(now);
    await this.audit(p, "runner.failure", { why });
    if (p.failures.length >= this.o.maxFailures) {
      p.status = "switched_off";
      this.stop(p);
      this.notices.push({
        pluginId: p.manifest.id,
        message: `${p.manifest.displayName ?? p.manifest.id} was switched off after ${p.failures.length} failures in a minute`,
        at: now,
      });
      await this.audit(p, "runner.switched_off", { failures: p.failures.length });
    }
  }

  // ---- calls from a plugin into the host ----

  private async audit(p: Loaded | null, action: string, detail: Record<string, unknown>) {
    try {
      await this.o.runner.all(
        `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "detail", "created_at") values (?, ?, 'plugin', ?, ?, ?, ?)`,
        [
          newId(),
          this.o.siteId,
          p?.manifest.id ?? "unknown",
          action,
          JSON.stringify(detail),
          new Date(),
        ],
      );
    } catch {
      /* the audit trail must not break a call; a failed write is visible in the server log */
      console.error("[oks sandbox] could not write the audit entry", action);
    }
  }

  private async onHostCall(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      /* an empty or broken body is treated as empty */
    }
    const token = String(req.headers["x-plugin-token"] ?? "");
    const p = this.byToken.get(token);
    // Compare in constant time as well (the lookup above is by exact string, which is fine for a random 128-bit token).
    if (!p || !timingSafeEqual(Buffer.from(p.tokenHex), Buffer.from(token))) {
      await this.audit(null, "host.unknown_caller", { route: req.url });
      return send(403, { error: "unknown caller" });
    }
    const route = req.url ?? "";
    if (!(route in ROUTE_PERMISSION)) {
      await this.audit(p, "host.unknown_route", { route });
      return send(404, { error: "unknown host route", code: "no_route" });
    }
    const need = ROUTE_PERMISSION[route];
    const granted = p.manifest.permissions;
    if (need && need !== "network:fetch" && !granted.includes(need)) {
      await this.audit(p, "host.denied", { route, need });
      return send(403, {
        error: `permission "${need}" was not approved`,
        code: "permission_denied",
      });
    }
    try {
      await this.audit(p, `host${route.replace("/", ".")}`, { route });
      switch (route) {
        case "/content/get": {
          const entry = await this.o.content.get(String(body["id"]));
          if (!entry) return send(404, { error: "not found" });
          if (entry.status !== "published" && !granted.includes("content:read_drafts")) {
            await this.audit(p, "host.denied", { route, need: "content:read_drafts" });
            return send(403, {
              error: 'permission "content:read_drafts" was not approved',
              code: "permission_denied",
            });
          }
          return send(200, { result: entry });
        }
        case "/content/update": {
          const raw = (body["patch"] ?? {}) as Record<string, unknown>;
          const patch: Record<string, unknown> = {};
          for (const key of ["title", "meta"]) if (key in raw) patch[key] = raw[key];
          const entry = await this.o.content.update(String(body["id"]), patch);
          return entry ? send(200, { result: entry }) : send(404, { error: "not found" });
        }
        case "/storage/get": {
          const rows = await this.o.runner.all(
            `select "value" from "extension_storage" where "extension_id" = ? and "collection" = ? and "key" = ?`,
            [p.extensionId, String(body["c"]), String(body["k"])],
          );
          const raw = rows[0]?.["value"];
          return send(200, {
            // SQLite keeps JSON as text; the PostgreSQL driver has already parsed jsonb (a stored JSON string arrives as a string).
            result:
              raw === undefined
                ? null
                : this.o.runner.dialect === "sqlite"
                  ? JSON.parse(String(raw))
                  : raw,
          });
        }
        case "/storage/set": {
          const value = JSON.stringify(body["v"] ?? null);
          const size = Buffer.byteLength(value);
          return await this.o.runner.transaction(async (tx) => {
            const used = Number(
              (
                await tx.all(
                  `select coalesce(sum("size_bytes"), 0) as used from "extension_storage" where "extension_id" = ?`,
                  [p.extensionId],
                )
              )[0]!["used"],
            );
            const existing = await tx.all(
              `select "size_bytes" from "extension_storage" where "extension_id" = ? and "collection" = ? and "key" = ?`,
              [p.extensionId, String(body["c"]), String(body["k"])],
            );
            const next = used - Number(existing[0]?.["size_bytes"] ?? 0) + size;
            if (next > this.o.storageLimitBytes)
              return send(413, { error: "storage limit reached", code: "storage_limit" });
            await tx.all(
              `insert into "extension_storage" ("extension_id", "collection", "key", "value", "size_bytes", "updated_at") values (?, ?, ?, ?, ?, ?)
               on conflict ("extension_id", "collection", "key") do update set "value" = excluded."value", "size_bytes" = excluded."size_bytes", "updated_at" = excluded."updated_at"`,
              [p.extensionId, String(body["c"]), String(body["k"]), value, size, new Date()],
            );
            return send(200, { result: true });
          });
        }
        case "/settings/get":
          return send(200, {
            result: (await this.o.settings?.(p.manifest.id, String(body["k"]))) ?? null,
          });
        case "/log":
          console.log(`[plugin ${p.manifest.id}] ${String(body["m"]).slice(0, 500)}`);
          return send(200, { result: true });
        case "/http/fetch": {
          let url: URL;
          try {
            url = new URL(String(body["url"]));
          } catch {
            return send(400, { error: "bad url", code: "bad_url" });
          }
          if (!granted.includes(`network:fetch:${url.hostname}`)) {
            await this.audit(p, "host.denied", { route, host: url.hostname });
            return send(403, {
              error: `host "${url.hostname}" was not approved`,
              code: "host_denied",
            });
          }
          try {
            const r = await safeFetch(url, { allowPrivateForTests: this.o.allowPrivateForTests });
            return send(200, { result: r });
          } catch (e) {
            if (e instanceof FetchRefused) {
              await this.audit(p, "host.denied", { route, host: url.hostname, why: e.code });
              return send(403, { error: e.message, code: e.code });
            }
            return send(502, {
              error: String((e as Error).message).slice(0, 200),
              code: "fetch_failed",
            });
          }
        }
      }
      return send(404, { error: "unknown host route" });
    } catch (e) {
      return send(500, { error: String((e as Error).message).slice(0, 200) });
    }
  }
}
