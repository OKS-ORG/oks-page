// /api/admin/plugins (Tools > Plugins): GET the installed plugins; POST {action:"preview"|"install", file, approved} to read a
// plugin file and to add it; PATCH {id, enabled} to switch one on or off; DELETE ?id=... to remove one. Only people who
// manage plugins.
import { fetchPluginFromNpm } from "@oks-page/sandbox";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import {
  hostFacts,
  installPlugin,
  listPlugins,
  previewPlugin,
  removePlugin,
  setPluginEnabled,
} from "./plugin-admin";
import { pluginHost, syncPlugin } from "./plugin-runtime";

const STATUS = { forbidden: 403, invalid: 400, not_found: 404, taken: 409 } as const;

/** The host, or null when it cannot start here (the plugin is still saved; the screen says it is not running). */
async function hostOrNull() {
  try {
    return await pluginHost();
  } catch {
    return null;
  }
}

export async function GET() {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  if (!(await actorOf(member)).can("plugins.manage"))
    return reply({ code: "forbidden", message: "You may not manage plugins." }, 403);
  const host = await hostOrNull();
  return NextResponse.json({
    plugins: await listPlugins(
      getRunner(),
      member.siteId,
      host ? (id) => host.status(id) : undefined,
    ),
    ...(host ? await hostFacts(host) : { limitsNote: null, notices: [] }),
  });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let input: {
    action?: unknown;
    file?: unknown;
    approved?: unknown;
    name?: unknown;
    version?: unknown;
    source?: unknown;
  };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const text = typeof input.file === "string" ? input.file : "";
  const actor = await actorOf(member);
  if (input.action === "npm") {
    // The server goes to the registry only for someone who may manage plugins.
    if (!actor.can("plugins.manage"))
      return reply({ code: "forbidden", message: "You may not manage plugins." }, 403);
    const registry = process.env["OKS_NPM_REGISTRY"];
    const fetched = await fetchPluginFromNpm(
      String(input.name ?? "").trim(),
      String(input.version ?? "").trim(),
      registry ? { registry } : {},
    );
    if (!fetched.ok) return reply({ code: "invalid", message: fetched.message }, 400);
    const result = await previewPlugin(getRunner(), actor, member.siteId, fetched.text);
    if (!result.ok) return reply(result, STATUS[result.code]);
    return NextResponse.json({
      plugin: result.plugin,
      file: fetched.text,
      source: `npm:${fetched.name}@${fetched.version}`,
    });
  }
  if (input.action === "preview") {
    const result = await previewPlugin(getRunner(), actor, member.siteId, text);
    if (!result.ok) return reply(result, STATUS[result.code]);
    return NextResponse.json({ plugin: result.plugin });
  }
  if (input.action === "install") {
    const approved = Array.isArray(input.approved) ? input.approved.map(String) : [];
    const source =
      typeof input.source === "string" && /^npm:[^\s]{1,260}$/.test(input.source)
        ? input.source
        : "file";
    const result = await installPlugin(getRunner(), actor, member.siteId, text, approved, source);
    if (!result.ok) return reply(result, STATUS[result.code]);
    const host = await hostOrNull();
    if (host) await syncPlugin(getRunner(), host, member.siteId, result.extensionId);
    return NextResponse.json({ ok: true, id: result.file.manifest.id, running: host !== null });
  }
  return reply({ code: "invalid", message: "The request was not understood." }, 400);
}

export async function PATCH(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let input: { id?: unknown; enabled?: unknown };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const result = await setPluginEnabled(
    getRunner(),
    await actorOf(member),
    member.siteId,
    String(input.id ?? ""),
    input.enabled === true,
  );
  if (!result.ok) return reply(result, STATUS[result.code]);
  const host = await hostOrNull();
  if (host) await syncPlugin(getRunner(), host, member.siteId, result.extensionId);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const host = await hostOrNull();
  const result = await removePlugin(getRunner(), await actorOf(member), member.siteId, id);
  if (!result.ok) return reply(result, STATUS[result.code]);
  host?.disable(id);
  return NextResponse.json({ ok: true });
}
