// /api/admin/publish (Tools > Publish): GET the saved places, how the last publish to each went, and whether one is running;
// POST {action:"save"|"run", ...} to add or change a place, or to publish to one; DELETE ?id=... to remove a place.
// Only people who manage the settings.
import {
  deletePublishTarget,
  listPublishTargets,
  loadPublishLast,
  savePublishTarget,
} from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import {
  exportFolder,
  exportReady,
  publishRunning,
  startPublish,
  zipFolder,
} from "./publish-runner";

const STATUS = { forbidden: 403, invalid: 400, not_found: 404 } as const;

export async function GET() {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  if (!(await actorOf(member)).can("settings.manage"))
    return reply({ code: "forbidden", message: "You may not change the settings." }, 403);
  const runner = getRunner();
  return NextResponse.json({
    targets: await listPublishTargets(runner, member.siteId),
    last: await loadPublishLast(runner, member.siteId),
    running: publishRunning(),
    exportReady: exportReady(),
    exportFolder: exportFolder(),
    zipFolder: zipFolder(),
  });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const actor = await actorOf(member);
  const runner = getRunner();
  if (input["action"] === "save") {
    const result = await savePublishTarget(runner, actor, member.siteId, input);
    if (!result.ok) return reply(result, STATUS[result.code]);
    return NextResponse.json({ ok: true, target: result.target });
  }
  if (input["action"] === "run") {
    if (!actor.can("settings.manage"))
      return reply({ code: "forbidden", message: "You may not change the settings." }, 403);
    const target = (await listPublishTargets(runner, member.siteId)).find(
      (t) => t.id === String(input["id"] ?? ""),
    );
    if (!target) return reply({ code: "not_found", message: "This place does not exist." }, 404);
    const started = startPublish(runner, member.siteId, target);
    if (!started.ok) return reply({ code: "invalid", message: started.message }, 409);
    return NextResponse.json({ ok: true });
  }
  return reply({ code: "invalid", message: "The request was not understood." }, 400);
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const result = await deletePublishTarget(getRunner(), await actorOf(member), member.siteId, id);
  if (!result.ok) return reply(result, STATUS[result.code]);
  return NextResponse.json({ ok: true });
}
