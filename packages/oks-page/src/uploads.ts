// Where uploaded files live and how the background work for them is started. The folder comes from OKS_UPLOADS_DIR
// (default: `uploads` in the project).
import path from "node:path";
import { drainJobs, MEDIA_JOB, mediaJobHandler, type MediaContext } from "@oks-page/core";
import { localAdapter } from "@oks-page/media";
import { getRunner } from "./db";

export function mediaContext(): MediaContext {
  const root = process.env["OKS_UPLOADS_DIR"] ?? path.join(process.cwd(), "uploads");
  return { storage: localAdapter({ root, baseUrl: "/uploads" }) };
}

/** Starts the jobs that make image sizes. It does not wait: the upload has already been answered. */
export function kickMediaJobs(): void {
  const runner = getRunner();
  void drainJobs(runner, { [MEDIA_JOB]: mediaJobHandler(runner, mediaContext()) }).catch(
    (error: unknown) => console.error("[oks] A media job failed to run:", error),
  );
}
