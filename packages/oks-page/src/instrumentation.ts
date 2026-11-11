// Runs once when the server starts (Next.js "instrumentation"). A project re-exports it from its own instrumentation.ts.
// It makes the tables of a new database. Set OKS_AUTO_MIGRATE=0 to run migrations yourself.
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  if (process.env["OKS_AUTO_MIGRATE"] === "0") return;
  // `next build` starts the server code too, with no database; only a running server migrates.
  if (process.env["NEXT_PHASE"] === "phase-production-build") return;
  const { migrateDatabase } = await import("./db");
  const applied = await migrateDatabase();
  if (applied.length > 0) console.log(`[oks] Applied ${applied.length} database migration(s).`);
  // Image sizes that were being made when the last server stopped are queued again, and waiting ones are run.
  try {
    const [{ recoverStaleJobs }, { getRunner }, { kickMediaJobs }] = await Promise.all([
      import("@oks-page/core"),
      import("./db"),
      import("./uploads"),
    ]);
    await recoverStaleJobs(getRunner());
    kickMediaJobs();
  } catch (error) {
    console.error("[oks] Could not start the background jobs:", error);
  }
  // Scheduled pages go live on time, and the old trash is emptied.
  try {
    const { startScheduler } = await import("./scheduler");
    startScheduler();
  } catch (error) {
    console.error("[oks] Could not start the scheduler:", error);
  }
}
