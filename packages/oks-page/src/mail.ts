// Email in the running site (spec 13): the site's secrets box (from OKS_SECRET), and the runner for queued emails. The
// scheduler runs the queue on every tick (so retries go out on time), and a newly queued email is sent at once.
import { drainJobs, EMAIL_JOB, emailJobHandler, SiteSecrets } from "@oks-page/core";
import { getRunner } from "./db";

let box: SiteSecrets | null = null;

/** The box that seals the email password and queued emails. */
export function siteSecrets(): SiteSecrets {
  box ??= new SiteSecrets(process.env["OKS_SECRET"] ?? "");
  return box;
}

/** Sends what is due in the email queue. */
export async function runEmailJobs(): Promise<void> {
  await drainJobs(getRunner(), { [EMAIL_JOB]: emailJobHandler(getRunner(), siteSecrets()) });
}

/** Starts sending without making the request wait. */
export function kickEmailJobs(): void {
  void runEmailJobs().catch((error: unknown) =>
    console.error("[oks] The email queue could not run:", error),
  );
}
