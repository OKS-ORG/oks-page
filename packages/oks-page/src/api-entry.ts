// PUT /api/admin/entries/[id]: save an entry. The core checks who may, repairs the blocks, writes the HTML and uses the
// revision rule; then the cached public page is refreshed. DELETE moves an entry to the trash (or, with ?forever=1,
// deletes one that is already in the trash); PATCH with {"action": "restore"} brings it back as a draft.
import { hooksFor } from "./plugin-hooks";
import {
  deleteForever,
  ensureRestorePoint,
  loadGeneralSettings,
  mayPublishAnyway,
  publishProblems,
  recordClientEdit,
  recordPublishOverride,
  restoreEntry,
  saveContent,
  sendReviewWaitingEmails,
  setCoverProvider,
  setMapCoverProvider,
  trashEntry,
  type PublishProblem,
} from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { STATUS_OF, isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { kickEmailJobs, siteSecrets } from "./mail";
import { refreshEntry } from "./refresh-cache";
import { siteOrigin } from "./site-origin";
import { mapCoverProvider, videoCoverProvider } from "./video-cover";

// A video or map block is given the picture it shows before a click when the page is saved (PB-94).
setCoverProvider(videoCoverProvider);
setMapCoverProvider(mapCoverProvider);

/** The plugins' hooks for a save, as an option of the save (nothing when no plugin is on). */
async function withHooks(
  runner: ReturnType<typeof getRunner>,
  siteId: string,
  actor: Awaited<ReturnType<typeof actorOf>>,
) {
  const hooks = await hooksFor(runner, siteId, actor);
  return hooks ? { hooks } : {};
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const runner = getRunner();
  const before = (
    await runner.all(
      `select "slug", "status", "type_key", "title", "revision" from "entries" where "id" = ?`,
      [id],
    )
  )[0];
  const actor = await actorOf(member);
  // A client's change to a page that is already live goes live at once (D60). The page as it is now is kept as a copy to go
  // back to, before the save, so the designer can undo it with one click.
  const clientLive =
    before?.["status"] === "published" &&
    actor.can("content.edit_live") &&
    !(actor.can("content.publish_any") || actor.can("content.publish_own"));
  let restoreCopy: string | null = null;
  if (clientLive) {
    try {
      restoreCopy = await ensureRestorePoint(runner, member.siteId, id);
    } catch (error) {
      console.error("[oks] The copy before a client's change could not be kept:", error);
    }
  }
  // Going live (published or scheduled) checks what a reader would miss. An administrator may go on anyway: the problems
  // are written to the audit log once the page is saved.
  const live = (status: unknown) => status === "published" || status === "scheduled";
  let setAside: PublishProblem[] = [];
  const mayGoLive = actor.can("content.publish_any") || actor.can("content.publish_own");
  // A page that is already published is not checked again; a scheduled one is, because it has not gone live yet.
  if (mayGoLive && live(input["status"]) && before?.["status"] !== "published") {
    const problems = publishProblems(String(input["title"] ?? ""), input["blocks"]);
    if (problems.length > 0) {
      const may = mayPublishAnyway(actor);
      if (!(may && input["publishAnyway"] === true))
        return NextResponse.json(
          {
            error: {
              code: "publish_check",
              message: `Before this goes live: ${problems.map((p) => p.message).join(" ")}`,
              problems,
              canPublishAnyway: may,
            },
          },
          { status: 422 },
        );
      setAside = problems;
    }
  }
  const result = await saveContent(
    runner,
    actor,
    member.siteId,
    id,
    {
      title: String(input["title"] ?? ""),
      slugPart: String(input["slugPart"] ?? ""),
      status: String(input["status"] ?? ""),
      scheduledAt: input["scheduledAt"] == null ? null : String(input["scheduledAt"]),
      blocks: input["blocks"],
      revision: Number(input["revision"]),
      ...(input["fields"] !== undefined ? { fields: input["fields"] } : {}),
    },
    undefined,
    {
      ...(setAside.length > 0 ? { publishAnyway: true } : {}),
      ...(await withHooks(runner, member.siteId, actor)),
    },
  );
  if (!result.ok) return reply(result, STATUS_OF[result.code]);
  if (setAside.length > 0) await recordPublishOverride(runner, actor, member.siteId, id, setAside);
  refreshEntry(id, result.slug, String(before?.["slug"] ?? result.slug));
  // A client changed a live page: the line in the log, and the email to the designers. A failure here never stops the save.
  if (clientLive && Number(result.revision) !== Number(before?.["revision"])) {
    try {
      const typeKey = String(before?.["type_key"] ?? "");
      const where =
        typeKey === "post" ? "posts" : typeKey === "page" ? "pages" : `content/${typeKey}`;
      const origin = siteOrigin(request);
      const noticed = await recordClientEdit(
        runner,
        siteSecrets(),
        {
          entryId: id,
          typeKey,
          title: String(input["title"] ?? before?.["title"] ?? ""),
          clientName: member.user.name,
          clientId: member.user.id,
          copyId: restoreCopy,
          revisionAfter: Number(result.revision),
          link: `${origin}/admin/${where}/${id}`,
          siteName: (await loadGeneralSettings(runner, member.siteId)).siteName,
          origin,
        },
        member.siteId,
      );
      if (noticed.notified > 0) kickEmailJobs();
    } catch (error) {
      console.error("[oks] The notice of a client's change could not be sent:", error);
    }
  }
  // Handed in for review: the people who may publish it are told. A failure here never stops the save.
  if (result.status === "pending" && before?.["status"] !== "pending") {
    try {
      const typeKey = String(before?.["type_key"] ?? "");
      const where =
        typeKey === "post" ? "posts" : typeKey === "page" ? "pages" : `content/${typeKey}`;
      const sent = await sendReviewWaitingEmails(runner, member.siteId, siteSecrets(), {
        typeKey,
        title: String(input["title"] ?? before?.["title"] ?? ""),
        author: member.user.name,
        authorId: member.user.id,
        siteName: (await loadGeneralSettings(runner, member.siteId)).siteName,
        link: `${siteOrigin(request)}/admin/${where}/${id}`,
      });
      if (sent > 0) kickEmailJobs();
    } catch (error) {
      console.error("[oks] The review email could not be queued:", error);
    }
  }
  return NextResponse.json({
    revision: result.revision,
    repairs: result.repairs,
    skippedBlocks: result.skippedBlocks,
    slug: result.slug,
    status: result.status,
    scheduledAt: result.scheduledAt,
  });
}

async function member_(request: Request) {
  if (!isSameOrigin(request))
    return {
      error: reply({ code: "forbidden", message: "This request came from another address." }, 403),
    };
  const member = await signedInMember();
  if (!member) return { error: reply({ code: "forbidden", message: "Sign in first." }, 401) };
  return { member };
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const who = await member_(request);
  if (!who.member) return who.error;
  const { id } = await context.params;
  const runner = getRunner();
  const actor = await actorOf(who.member);
  if (new URL(request.url).searchParams.get("forever") === "1") {
    const gone = await deleteForever(runner, actor, who.member.siteId, id);
    if (!gone.ok) return reply(gone, STATUS_OF[gone.code]);
    return NextResponse.json({ ok: true });
  }
  const before = (await runner.all(`select "slug" from "entries" where "id" = ?`, [id]))[0];
  const moved = await trashEntry(runner, actor, who.member.siteId, id);
  if (!moved.ok) return reply(moved, STATUS_OF[moved.code]);
  if (before) refreshEntry(id, String(before["slug"]));
  return NextResponse.json({ ok: true });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const who = await member_(request);
  if (!who.member) return who.error;
  const { id } = await context.params;
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  if (input["action"] !== "restore")
    return reply({ code: "invalid", message: "This action is not known." }, 400);
  const back = await restoreEntry(getRunner(), await actorOf(who.member), who.member.siteId, id);
  if (!back.ok) return reply(back, STATUS_OF[back.code]);
  return NextResponse.json({ ok: true, slug: back.slug });
}
