// The sandbox host (spec 04, section 5): one workerd process per plugin, a host API they call with their own token,
// a watchdog that kills a stuck plugin, and a count of failures that switches a plugin off.
import { checkBlocks } from "@oks-page/content-safety";
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
import { developerMessage, ownerSentence } from "./permission-text.js";
import { FetchRefused, safeFetch } from "./safe-fetch.js";
import type { PluginSettings } from "./settings.js";
import type {
  ActingUser,
  CallKind,
  CallOptions,
  CallResult,
  ContentService,
  DeveloperNote,
  FilterRun,
  JobInfo,
  OwnerNotice,
  PermissionNote,
  PermissionRefusal,
  PluginManifest,
  PluginStatus,
  PublishCheck,
  PublishCheckNote,
  RouteInfo,
  RouteRequest,
  RouteRun,
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
  "/storage/list": null,
  "/storage/delete": null,
  "/email/send": "email:send",
  "/files/attach": "files:private",
  "/settings/get": null,
  "/log": null,
  "/http/fetch": "network:fetch",
};

export interface HostOptions {
  runner: SqlRunner;
  siteId: string;
  content: ContentService;
  settings?: (pluginId: string, key: string) => Promise<unknown>;
  /** The plugins' saved settings (PL-39). When set, a plugin reads its own settings from here, secrets in full; it can
   * never name another plugin, because the host looks them up by the calling plugin's own extension. */
  pluginSettings?: PluginSettings;
  /** Sends one email for a plugin that has `email:send` (the site's email queue). `reason` is for the plugin's log. */
  sendEmail?: (
    pluginId: string,
    mail: { to: string; subject: string; text: string },
  ) => Promise<{ sent: boolean; reason?: string }>;
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
  /** The time limit for a before-publish check (spec 04, section 5.3: 5 seconds). */
  publishWallMs?: number;
  /** The time limit for one run of a plugin's job (30 seconds). */
  jobWallMs?: number;
  /** Where the message for the developer goes when a plugin is refused a permission (ADR 0036). Default: the server log. */
  onDeveloperNote?: (note: DeveloperNote) => void;
  /** Tests only. */
  allowPrivateForTests?: boolean;
  /** Tests only: pretend the system cannot cap memory. */
  pretendNoMemoryLimit?: boolean;
}

/** One call into a plugin that is still running; the plugin's calls to the host name it, so a refusal can say which hook it was. */
interface ActiveCall {
  kind: CallKind;
  name: string;
  refusals: PermissionRefusal[];
  /** The person the call acts for, if any (PL-38). */
  actingFor?: ActingUser;
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
  active: Map<string, ActiveCall>;
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
  private readonly emailCount = new Map<string, { hour: number; count: number }>();
  private readonly byToken = new Map<string, Loaded>();
  private server: Server | null = null;
  private hostPort = 0;
  private readonly o: Required<
    Omit<
      HostOptions,
      | "settings"
      | "pluginSettings"
      | "sendEmail"
      | "onDeveloperNote"
      | "runner"
      | "siteId"
      | "content"
      | "workDir"
    >
  > &
    Pick<
      HostOptions,
      | "settings"
      | "pluginSettings"
      | "sendEmail"
      | "onDeveloperNote"
      | "runner"
      | "siteId"
      | "content"
      | "workDir"
    >;

  constructor(options: HostOptions) {
    this.o = {
      wallMs: 2000,
      maxFailures: 3,
      failureWindowMs: 60_000,
      storageLimitBytes: 10_000_000,
      memoryMb: 0,
      idleMs: 0,
      publishWallMs: 5000,
      jobWallMs: 30_000,
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
      active: new Map(),
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

  /** True when the plugin is loaded, on, and has been approved for `permission`. */
  isAllowed(id: string, permission: string): boolean {
    const p = this.plugins.get(id);
    return p !== undefined && p.status === "enabled" && p.manifest.permissions.includes(permission);
  }

  /** Switches a plugin off by hand (the owner does this from the admin). It is not run and not asked again. */
  disable(id: string): void {
    const p = this.plugins.get(id);
    if (!p) return;
    p.status = "disabled";
    this.stop(p);
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

  /** The hooks and blocks the plugin's code really has, read by starting it. `oks check` compares this with the
   * manifest (spec 04, section 11). Null for a plugin that is not loaded. */
  async describe(
    id: string,
  ): Promise<{ hooks: string[]; blocks: string[]; routes: string[]; jobs: string[] } | null> {
    const p = this.plugins.get(id);
    if (!p) return null;
    await this.start(p);
    this.touch(p);
    const response = await fetch(`http://127.0.0.1:${p.port}/describe`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(this.o.wallMs),
    });
    const body = (await response.json()) as {
      result?: { hooks: string[]; blocks: string[]; routes?: string[]; jobs?: string[] };
    };
    return body.result
      ? { ...body.result, routes: body.result.routes ?? [], jobs: body.result.jobs ?? [] }
      : null;
  }

  /** True when the owner approved this permission for the plugin (the permissions the host was given when it loaded it). */
  allowed(id: string, permission: string): boolean {
    return this.plugins.get(id)?.manifest.permissions.includes(permission) ?? false;
  }

  /** The row of a plugin in the `extensions` table (its stored items and files belong to it), or null when it is unknown. */
  extensionOf(id: string): string | null {
    return this.plugins.get(id)?.extensionId ?? null;
  }

  /** The jobs a plugin declared, by name, or none when it is unknown or switched off. The site reads this to know
   * what to schedule. */
  jobsOf(id: string): Record<string, JobInfo> {
    const p = this.plugins.get(id);
    return p && p.status === "enabled" ? (p.manifest.jobs ?? {}) : {};
  }

  /**
   * Runs one of a plugin's jobs (spec 04, section 9), as the site's timer asks. It checks that the plugin is switched on
   * and lists the job, then calls it with the job time limit (30 seconds) and the same failure rules as a hook: a job
   * that fails or is too slow counts toward switching the plugin off. A job has no request and no answer.
   */
  async runJob(
    id: string,
    name: string,
    options: { at?: number } = {},
  ): Promise<{ ok: true } | { ok: false; skipped: boolean; error: string }> {
    const p = this.plugins.get(id);
    if (!p || p.status !== "enabled" || !p.manifest.jobs?.[name])
      return { ok: false, skipped: true, error: "This job is not available." };
    const r = await this.call(
      id,
      "job",
      name,
      { at: options.at ?? Date.now() },
      {
        timeoutMs: this.o.jobWallMs,
      },
    );
    if (r.ok) return { ok: true };
    return {
      ok: false,
      skipped: r.skipped === true,
      error: String(r.error ?? "The job failed.").slice(0, 300),
    };
  }

  /** What the plugin declared for one of its routes, or null when there is no such route to use: the plugin is unknown,
   * switched off or was not given `routes:public`. The site reads this before it reads a request. */
  routeInfo(id: string, name: string): RouteInfo | null {
    const p = this.plugins.get(id);
    const info = p?.manifest.routes?.[name];
    if (!p || p.status !== "enabled" || !info || !p.manifest.permissions.includes("routes:public"))
      return null;
    return info;
  }

  /**
   * Runs one of a plugin's routes (spec 04, section 9). The site has already read the request; this checks that the
   * plugin may have the route (it is switched on, has `routes:public` and lists the route in its manifest), calls it
   * and turns the answer into one of a few safe shapes: a status, then JSON, text, or a redirect to a path on this site.
   * A plugin that fails or is too slow gives a 502 that says nothing about the plugin's insides.
   */
  async runRoute(
    id: string,
    name: string,
    request: RouteRequest,
    options: CallOptions = {},
  ): Promise<RouteRun> {
    const p = this.plugins.get(id);
    const info = p?.manifest.routes?.[name];
    if (!p || p.status !== "enabled" || !info || !p.manifest.permissions.includes("routes:public"))
      return { ok: false, status: 404, message: "There is nothing at this address." };
    if (info.method !== request.method)
      return {
        ok: false,
        status: 405,
        message: "This address does not take this kind of request.",
      };
    const r = await this.call(id, "route", name, request, {
      ...options,
      timeoutMs: options.timeoutMs ?? this.o.publishWallMs,
    });
    if (!r.ok || r.skipped)
      return {
        ok: false,
        status: r.ok === false && r.error === "timeout" ? 504 : 502,
        message: "The plugin could not answer this request.",
      };
    const a = r.result as Record<string, unknown> | null | undefined;
    if (a === null || typeof a !== "object" || Array.isArray(a))
      return { ok: false, status: 502, message: "The plugin could not answer this request." };
    const status = a["status"] === undefined ? 200 : Number(a["status"]);
    if (
      !Number.isInteger(status) ||
      status < 200 ||
      status > 599 ||
      (status >= 300 && status < 400)
    )
      return { ok: false, status: 502, message: "The plugin could not answer this request." };
    const kinds = ["json", "text", "redirect", "page"].filter((k) => a[k] !== undefined);
    if (kinds.length !== 1)
      return { ok: false, status: 502, message: "The plugin could not answer this request." };
    if (kinds[0] === "redirect") {
      const to = a["redirect"];
      if (
        typeof to !== "string" ||
        !/^\/(?![/\\])\S{0,500}$/u.test(to) ||
        [...to].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      )
        return { ok: false, status: 502, message: "The plugin could not answer this request." };
      return { ok: true, reply: { status: 303, redirect: to } };
    }
    if (kinds[0] === "page") {
      const page = a["page"] as Record<string, unknown> | null;
      const title = page?.["title"];
      const text = page?.["text"];
      if (
        page === null ||
        typeof page !== "object" ||
        typeof title !== "string" ||
        typeof text !== "string" ||
        title.length > 200 ||
        text.length > 4000
      )
        return { ok: false, status: 502, message: "The plugin could not answer this request." };
      return { ok: true, reply: { status, page: { title, text } } };
    }
    if (kinds[0] === "text") {
      if (typeof a["text"] !== "string" || a["text"].length > 200_000)
        return { ok: false, status: 502, message: "The plugin could not answer this request." };
      return { ok: true, reply: { status, text: a["text"] } };
    }
    let size: number;
    try {
      size = JSON.stringify(a["json"] ?? null).length;
    } catch {
      size = Infinity;
    }
    if (size > 200_000)
      return { ok: false, status: 502, message: "The plugin could not answer this request." };
    return { ok: true, reply: { status, json: a["json"] ?? null } };
  }

  async call(
    id: string,
    kind: CallKind,
    name: string,
    payload: unknown,
    options: CallOptions = {},
  ): Promise<CallResult> {
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
    // The plugin sends this id with each call it makes to the host, so a refusal can name the hook it happened in.
    const callId = randomBytes(8).toString("hex");
    const active: ActiveCall = {
      kind,
      name,
      refusals: [],
      ...(options.actingFor ? { actingFor: options.actingFor } : {}),
    };
    p.active.set(callId, active);
    const refusals = () =>
      active.refusals.length > 0 ? { permissionRefusals: [...active.refusals] } : {};
    try {
      await this.start(p);
      this.touch(p);
      const response = await fetch(
        `http://127.0.0.1:${p.port}/${kind}/${encodeURIComponent(name)}`,
        {
          method: "POST",
          body: JSON.stringify(
            kind === "hook" ? { event: payload, callId } : { props: payload, callId },
          ),
          signal: AbortSignal.timeout(options.timeoutMs ?? this.o.wallMs),
        },
      );
      const body = (await response.json()) as {
        ok: boolean;
        result?: unknown;
        skipped?: boolean;
        error?: string;
        code?: string;
      };
      // A refusal for a missing permission is not a failure (ADR 0036): the plugin is built wrong, it is not crashing.
      // Only a refusal the host really made in this call is excused, so a plugin cannot pass an error off as one.
      const refused = body.code !== undefined && active.refusals.some((r) => r.code === body.code);
      if (!body.ok && !body.skipped && !refused)
        await this.recordFailure(p, `error: ${body.error ?? "unknown"}`);
      return { ...body, ms: ms(), ...refusals() } as CallResult;
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
      if (process.env.OKS_DEBUG_SANDBOX) console.error("[oks sandbox] call failed:", e);
      this.stop(p);
      await this.recordFailure(
        p,
        timedOut ? "timeout" : `crash: ${String((e as Error).message).slice(0, 60)}`,
      );
      return {
        ok: false,
        error: timedOut ? "timeout" : "crashed",
        killed: true,
        ms: ms(),
        ...refusals(),
      };
    } finally {
      p.active.delete(callId);
    }
  }

  /** May `entry` be published? Runs every enabled plugin's `content:beforePublish` hook, by priority and then install
   * order (spec 04, section 7). Only an explicit refusal (`{ refuse: "Add a featured image first" }`) from a plugin
   * that worked blocks publishing, and the first one stops the check. A plugin that fails, crashes, gives an answer of
   * the wrong shape or takes longer than the publish time limit is skipped: publishing goes ahead without it and the
   * owner is told (spec 04, section 5.3, "Fail open"; PL-40). */
  async beforePublish(entry: unknown, options: CallOptions = {}): Promise<PublishCheck> {
    const entryId = String((entry as { id?: unknown } | null)?.id ?? "");
    const order = [...this.plugins.values()]
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.status === "enabled")
      .sort((a, b) => (a.p.manifest.priority ?? 10) - (b.p.manifest.priority ?? 10) || a.i - b.i);
    const skipped: PublishCheck["skipped"] = [];
    for (const { p } of order) {
      const r = await this.call(p.manifest.id, "hook", "content:beforePublish", entry, {
        ...options,
        timeoutMs: options.timeoutMs ?? this.o.publishWallMs,
      });
      if (r.ok && r.skipped) continue; // the plugin has no before-publish hook
      const name = p.manifest.displayName ?? p.manifest.id;
      const refuse = r.ok
        ? (r.result as { refuse?: unknown } | null | undefined)?.refuse
        : undefined;
      if (r.ok && refuse === undefined) continue;
      if (r.ok && typeof refuse === "string" && refuse.trim() !== "") {
        const message = refuse.trim().slice(0, 300);
        await this.audit(p, "publish.refused", { entry: entryId, message });
        return { allowed: false, refusal: { pluginId: p.manifest.id, message }, skipped };
      }
      // Failed, crashed, too slow, or an answer of the wrong shape: skip it, publish anyway, tell the owner.
      const why: "timeout" | "failed" = !r.ok && r.error === "timeout" ? "timeout" : "failed";
      const message =
        why === "timeout"
          ? `${name} took too long to check this before it was published, so it was published without that check.`
          : `${name} could not check this before it was published, so it was published without that check.`;
      skipped.push({ pluginId: p.manifest.id, why, message });
      await this.audit(p, "publish.check_failed", {
        entry: entryId,
        why,
        error: r.ok ? "an answer of the wrong shape" : r.error,
      });
    }
    return { allowed: true, skipped };
  }

  private enabledInOrder() {
    return [...this.plugins.values()]
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.status === "enabled")
      .sort((a, b) => (a.p.manifest.priority ?? 10) - (b.p.manifest.priority ?? 10) || a.i - b.i)
      .map(({ p }) => p);
  }

  /**
   * Runs a filter hook through every enabled plugin, by priority and then install order (spec 04, section 7): a plugin's
   * answer goes to the next one. An answer that is not an object, is too big, or comes from a plugin that failed or took
   * too long is dropped and the value passes on unchanged (fail open, section 5.3). A plugin that changes the value needs
   * the permission `content:write`; without it the change is dropped and the refusal is kept for the owner's note.
   */
  async runFilter(name: string, value: unknown, options: CallOptions = {}): Promise<FilterRun> {
    const out: FilterRun = { value, applied: [], skipped: [] };
    for (const p of this.enabledInOrder()) {
      const r = await this.call(p.manifest.id, "hook", name, out.value, options);
      if (r.ok && r.skipped) continue; // the plugin has no such hook
      const label = p.manifest.displayName ?? p.manifest.id;
      if (!r.ok) {
        if (r.permissionRefusals?.length) continue;
        const why: "timeout" | "failed" = r.error === "timeout" ? "timeout" : "failed";
        out.skipped.push({
          pluginId: p.manifest.id,
          why,
          message: `${label} could not run "${name}", so the page was saved without its change.`,
        });
        continue;
      }
      const answer = r.result;
      if (answer === null || typeof answer !== "object" || Array.isArray(answer)) continue;
      let size: number;
      try {
        size = JSON.stringify(answer).length;
      } catch {
        size = Infinity;
      }
      if (size > 200_000) {
        out.skipped.push({
          pluginId: p.manifest.id,
          why: "failed",
          message: `${label} gave an answer to "${name}" that is too big, so it was left out.`,
        });
        continue;
      }
      if (JSON.stringify(answer) === JSON.stringify(out.value)) continue;
      if (!p.manifest.permissions.includes("content:write")) {
        await this.audit(p, "host.denied", {
          route: "filter",
          need: "content:write",
          kind: "hook",
          name,
        });
        const message = developerMessage({ kind: "hook", name }, "content:write");
        if (this.o.onDeveloperNote)
          this.o.onDeveloperNote({
            pluginId: p.manifest.id,
            permission: "content:write",
            code: "permission_denied",
            message,
            call: { kind: "hook", name },
          });
        else console.warn(`[plugin ${p.manifest.id}] ${message}`);
        continue;
      }
      out.value = answer;
      out.applied.push({ pluginId: p.manifest.id, value: answer });
    }
    return out;
  }

  /**
   * Runs an action hook in every enabled plugin (spec 04, section 7): they react after the main work, their answers are
   * not used, and a failure is only counted (three in a minute switch the plugin off). Never throws.
   */
  async runAction(name: string, value: unknown, options: CallOptions = {}): Promise<void> {
    for (const p of this.enabledInOrder()) {
      try {
        await this.call(p.manifest.id, "hook", name, value, options);
      } catch {
        // a plugin never stops the others
      }
    }
  }

  /** One note for the owner per plugin whose before-publish check could not run (PL-40), however often it happened.
   * Built from the audit trail, so it survives a restart. */
  async publishCheckNotes(): Promise<PublishCheckNote[]> {
    const rows = await this.o.runner.all(
      `select "actor_id", "created_at" from "audit_log" where "site_id" = ? and "actor_type" = 'plugin' and "action" = 'publish.check_failed' order by "created_at"`,
      [this.o.siteId],
    );
    const notes = new Map<string, PublishCheckNote>();
    for (const row of rows) {
      const pluginId = String(row["actor_id"]);
      const at = new Date(row["created_at"] as string | number | Date).getTime();
      const note = notes.get(pluginId);
      if (note) {
        note.count++;
        note.lastAt = at;
        continue;
      }
      const name = this.plugins.get(pluginId)?.manifest.displayName ?? pluginId;
      notes.set(pluginId, {
        pluginId,
        message: `${name} could not check some posts before they were published. They were published without that check.`,
        count: 1,
        firstAt: at,
        lastAt: at,
      });
    }
    for (const note of notes.values())
      if (note.count > 1)
        note.message = `${this.plugins.get(note.pluginId)?.manifest.displayName ?? note.pluginId} could not check posts before they were published ${note.count} times. They were published without that check.`;
    return [...notes.values()];
  }

  /** What the owner should be told about permissions the plugins were refused (spec 04, section 7; ADR 0036): one
   * note for each plugin and permission, however many times it happened. Built from the `host.denied` audit rows, so it
   * survives a restart and needs no table of its own. A permission the owner has approved since is not listed. */
  async permissionNotes(): Promise<PermissionNote[]> {
    const rows = await this.o.runner.all(
      `select "actor_id", "detail", "created_at" from "audit_log" where "site_id" = ? and "actor_type" = 'plugin' and "action" = 'host.denied' order by "created_at"`,
      [this.o.siteId],
    );
    const notes = new Map<string, PermissionNote>();
    for (const row of rows) {
      const raw = row["detail"];
      const detail = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
      // A refusal that is not about a permission (a blocked address, for example) has no `need`.
      if (typeof detail["need"] !== "string") continue;
      const need = detail["need"];
      const pluginId = String(row["actor_id"]);
      const loaded = this.plugins.get(pluginId);
      if (loaded?.manifest.permissions.includes(need)) continue;
      const at =
        row["created_at"] instanceof Date ? row["created_at"].getTime() : Number(row["created_at"]);
      const key = `${pluginId}\n${need}`;
      let note = notes.get(key);
      if (!note) {
        note = {
          pluginId,
          permission: need,
          message: ownerSentence(loaded?.manifest.displayName ?? pluginId, need),
          calls: [],
          count: 0,
          firstAt: at,
          lastAt: at,
        };
        notes.set(key, note);
      }
      note.count++;
      note.firstAt = Math.min(note.firstAt, at);
      note.lastAt = Math.max(note.lastAt, at);
      const kind = detail["kind"] === "block" ? "block" : "hook";
      const callName = detail["name"];
      if (
        typeof callName === "string" &&
        !note.calls.some((c) => c.kind === kind && c.name === callName)
      )
        note.calls.push({ kind, name: callName });
    }
    return [...notes.values()].sort((a, b) => b.lastAt - a.lastAt);
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
    // The call this one belongs to. The plugin sends the id, so it is only used to look up the host's own record of
    // that call (to name the hook); an id the plugin made up, or a call that is over, finds nothing.
    const during = p.active.get(String(req.headers["x-oks-call"] ?? ""));
    /** The one answer to a call that needs a permission the plugin does not have (spec 04, section 4.1, rule 1; ADR 0036):
     * keep it in the audit trail (the owner's note is built from there), tell the developer which hook needs which
     * permission, and refuse with the fix in the answer. */
    const refuse = async (
      permission: string,
      code: PermissionRefusal["code"],
      error: string,
      detail: Record<string, unknown> = {},
    ) => {
      await this.audit(p, "host.denied", {
        route,
        need: permission,
        ...detail,
        ...(during ? { kind: during.kind, name: during.name } : {}),
      });
      const message = developerMessage(during, permission);
      if (!during || !during.refusals.some((r) => r.permission === permission)) {
        during?.refusals.push({ permission, code, message });
        const note: DeveloperNote = {
          pluginId: p.manifest.id,
          permission,
          code,
          message,
          ...(during ? { call: { kind: during.kind, name: during.name } } : {}),
        };
        if (this.o.onDeveloperNote) this.o.onDeveloperNote(note);
        else console.warn(`[plugin ${note.pluginId}] ${message}`);
      }
      return send(403, { error, code, fix: message });
    };
    if (need && need !== "network:fetch" && !granted.includes(need))
      return refuse(need, "permission_denied", `permission "${need}" was not approved`);
    /** A call that acts for a person may not do what that person may not (spec 02, section 8, rule 1; PL-38). This is
     * not the plugin's fault, so it is no failure and no note for the owner; it is kept in the audit trail. */
    const userRefuse = async (capability: string, entryId: string) => {
      await this.audit(p, "host.denied_user", {
        route,
        need: capability,
        user: during?.actingFor?.userId,
        entry: entryId,
        ...(during ? { kind: during.kind, name: during.name } : {}),
      });
      const message = `The person this ${during?.kind ?? "call"} acts for may not do this ("${capability}"). A plugin never gets more power than the person it acts for.`;
      if (
        during &&
        !during.refusals.some((r) => r.code === "user_denied" && r.permission === capability)
      )
        during.refusals.push({ permission: capability, code: "user_denied", message });
      return send(403, { error: message, code: "user_denied" });
    };
    const actingFor = during?.actingFor;
    const own = (entry: { authorId?: string }) =>
      actingFor !== undefined &&
      entry.authorId !== undefined &&
      entry.authorId === actingFor.userId;
    try {
      await this.audit(p, `host${route.replace("/", ".")}`, { route });
      switch (route) {
        case "/content/get": {
          const entry = await this.o.content.get(String(body["id"]));
          if (!entry) return send(404, { error: "not found" });
          if (entry.status !== "published" && !granted.includes("content:read_drafts"))
            return refuse(
              "content:read_drafts",
              "permission_denied",
              'permission "content:read_drafts" was not approved',
            );
          // Anyone may read what is published; anything else only a person who may see it (PL-38).
          if (
            actingFor &&
            entry.status !== "published" &&
            !actingFor.can("content.read_private", entry.typeKey) &&
            !actingFor.can("content.edit_any", entry.typeKey) &&
            !(own(entry) && actingFor.can("content.edit_own", entry.typeKey))
          )
            return userRefuse(own(entry) ? "content.edit_own" : "content.read_private", entry.id);
          return send(200, { result: entry });
        }
        case "/content/update": {
          if (actingFor) {
            const current = await this.o.content.get(String(body["id"]));
            if (!current) return send(404, { error: "not found" });
            if (
              !actingFor.can("content.edit_any", current.typeKey) &&
              !(own(current) && actingFor.can("content.edit_own", current.typeKey))
            )
              return userRefuse(own(current) ? "content.edit_own" : "content.edit_any", current.id);
          }
          const raw = (body["patch"] ?? {}) as Record<string, unknown>;
          const patch: Record<string, unknown> = {};
          for (const key of ["title", "meta"]) if (key in raw) patch[key] = raw[key];
          // The block checks run here, before the write reaches the content service, so a
          // hostile or careless plugin can never store an unsafe block tree (PL-37).
          if ("body" in raw) {
            const { body: checked, repairs } = checkBlocks(raw["body"]);
            patch["body"] = checked;
            if (repairs.length > 0) await this.audit(p, "content.write_repaired", { repairs });
          }
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
        case "/storage/list": {
          const limit = Math.min(Math.max(Math.trunc(Number(body["limit"]) || 50), 1), 200);
          const desc = body["order"] === "desc";
          const after = typeof body["after"] === "string" ? body["after"] : null;
          const rows = await this.o.runner.all(
            `select "key", "value", "updated_at" from "extension_storage" where "extension_id" = ? and "collection" = ?${
              after === null ? "" : ` and "key" ${desc ? "<" : ">"} ?`
            } order by "key" ${desc ? "desc" : "asc"} limit ${limit}`,
            after === null
              ? [p.extensionId, String(body["c"])]
              : [p.extensionId, String(body["c"]), after],
          );
          return send(200, {
            result: rows.map((r) => ({
              key: String(r["key"]),
              value:
                this.o.runner.dialect === "sqlite" && typeof r["value"] === "string"
                  ? (JSON.parse(r["value"]) as unknown)
                  : r["value"],
              updatedAt: new Date(r["updated_at"] as string | number | Date).getTime(),
            })),
          });
        }
        case "/storage/delete": {
          const item = [p.extensionId, String(body["c"]), String(body["k"])];
          // The files kept with an item go with it.
          await this.o.runner.transaction(async (tx) => {
            await tx.all(
              `delete from "extension_storage" where "extension_id" = ? and "collection" = ? and "key" = ?`,
              item,
            );
            await tx.all(
              `delete from "extension_files" where "extension_id" = ? and "collection" = ? and "key" = ?`,
              item,
            );
          });
          return send(200, { result: true });
        }
        case "/files/attach": {
          // Only this plugin's own files that were just received can be attached; the files then belong to the item.
          const ids = (Array.isArray(body["ids"]) ? (body["ids"] as unknown[]) : [])
            .filter((x): x is string => typeof x === "string" && x.length === 26)
            .slice(0, 10);
          if (ids.length === 0) return send(200, { result: 0 });
          const rows = await this.o.runner.all(
            `update "extension_files" set "status" = 'kept', "collection" = ?, "key" = ? where "extension_id" = ? and "status" = 'pending' and "id" in (${ids.map(() => "?").join(", ")}) returning "id"`,
            [String(body["c"]), String(body["k"]), p.extensionId, ...ids],
          );
          return send(200, { result: rows.length });
        }
        case "/email/send": {
          if (!this.o.sendEmail)
            return send(501, { error: "email is not available", code: "no_email" });
          const to = body["to"];
          const subject = body["subject"];
          const text = body["text"];
          if (
            typeof to !== "string" ||
            typeof subject !== "string" ||
            typeof text !== "string" ||
            to.length > 254 ||
            subject.length === 0 ||
            subject.length > 200 ||
            text.length > 20_000 ||
            /[\r\n]/.test(to + subject)
          )
            return send(400, { error: "bad email", code: "bad_email" });
          // At most 60 emails an hour for each plugin, so a plugin that loops cannot flood anyone's inbox.
          const hour = Math.floor(Date.now() / 3_600_000);
          const used = this.emailCount.get(p.manifest.id);
          const count = used && used.hour === hour ? used.count : 0;
          if (count >= 60)
            return send(429, { error: "too many emails this hour", code: "email_limit" });
          this.emailCount.set(p.manifest.id, { hour, count: count + 1 });
          const sent = await this.o.sendEmail(p.manifest.id, { to, subject, text });
          return send(200, { result: sent });
        }
        case "/settings/get":
          return send(200, {
            result:
              (this.o.pluginSettings
                ? await this.o.pluginSettings.forPlugin(p.extensionId, String(body["k"]))
                : await this.o.settings?.(p.manifest.id, String(body["k"]))) ?? null,
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
          if (!url.hostname) {
            // An address with no host (file:///...) is refused, but it is not a permission the owner could approve.
            await this.audit(p, "host.denied", { route, host: "", why: "no_host" });
            return send(403, { error: "the address has no host name", code: "host_denied" });
          }
          if (!granted.includes(`network:fetch:${url.hostname}`))
            return refuse(
              `network:fetch:${url.hostname}`,
              "host_denied",
              `host "${url.hostname}" was not approved`,
              { host: url.hostname },
            );
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
