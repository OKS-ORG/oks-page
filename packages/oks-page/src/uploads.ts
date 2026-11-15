// Where uploaded files live and how the background work for them is started. On the local disk by default, in the folder
// OKS_UPLOADS_DIR (default: `uploads` in the project); in an S3-compatible bucket with OKS_STORAGE=s3 and the OKS_S3_*
// settings (spec 09, section 7). Either way the site serves the files at /uploads/<key>.
import path from "node:path";
import {
  drainJobs,
  loadMediaSettings,
  MEDIA_JOB,
  mediaJobHandler,
  type MediaContext,
} from "@oks-page/core";
import { localAdapter, s3Adapter, s3OptionsFromEnv, type StorageAdapter } from "@oks-page/media";
import { getRunner } from "./db";
import { expireTags } from "./expire-tags";

const shared = globalThis as typeof globalThis & {
  __oksStorage?: { from: string; storage: StorageAdapter };
};

/** The storage from the settings where the site runs; made once and kept while they stay the same. */
function storage(): StorageAdapter {
  const s3 = s3OptionsFromEnv(process.env);
  const root = process.env["OKS_UPLOADS_DIR"] ?? path.join(process.cwd(), "uploads");
  const from = s3 ? JSON.stringify(s3) : root;
  if (shared.__oksStorage?.from === from) return shared.__oksStorage.storage;
  const made = s3 ? s3Adapter(s3) : localAdapter({ root, baseUrl: "/uploads" });
  shared.__oksStorage = { from, storage: made };
  return made;
}

export function mediaContext(): MediaContext {
  return { storage: storage() };
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
