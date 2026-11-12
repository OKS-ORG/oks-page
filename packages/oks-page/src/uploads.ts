// Where uploaded files live and how the background work for them is started. The folder comes from OKS_UPLOADS_DIR
// (default: `uploads` in the project).
import path from "node:path";
import {
  drainJobs,
  loadMediaSettings,
  MEDIA_JOB,
  mediaJobHandler,
  type MediaContext,
} from "@oks-page/core";
import { localAdapter } from "@oks-page/media";
import { getRunner } from "./db";
import { expireTags } from "./expire-tags";

export function mediaContext(): MediaContext {
  const root = process.env["OKS_UPLOADS_DIR"] ?? path.join(process.cwd(), "uploads");
  return { storage: localAdapter({ root, baseUrl: "/uploads" }) };
}

/** The same, with the limits the site owner saved in the media settings (the biggest file and picture, photo details). */
export async function mediaContextFor(siteId: string): Promise<MediaContext> {
  return { ...mediaContext(), settings: await loadMediaSettings(getRunner(), siteId) };
}

/** Starts the jobs that make image sizes. It does not wait: the upload has already been answered. */
export function kickMediaJobs(): void {
  const runner = getRunner();
  const handler = mediaJobHandler(runner, mediaContext());
  const withRefresh = {
    ...handler,
    // Once the sizes exist, the public pages that show this image are made fresh so they use the sizes.
    run: async (job: Parameters<typeof handler.run>[0]) => {
      // The picture limit is read when the job runs, so a change in the settings counts at once.
      await mediaJobHandler(runner, await mediaContextFor(job.siteId)).run(job);
      const mediaId = String((job.payload as { mediaId?: unknown }).mediaId ?? "");
      const pages = await runner.all(
        `select e."id", e."slug", e."site_id" from "entry_media" m join "entries" e on e."id" = m."entry_id"
          where m."media_id" = ? and e."status" = 'published'`,
        [mediaId],
      );
      for (const p of pages)
        await expireTags(String(p["site_id"]), String(p["id"]), String(p["slug"]));
    },
  };
  void drainJobs(runner, { [MEDIA_JOB]: withRefresh }).catch((error: unknown) =>
    console.error("[oks] A media job failed to run:", error),
  );
}
