// A passkey added or removed is always written to the audit log (spec 02, section "Audit"; AU-41). The passkey itself
// is kept by the sign-in library; this is only the record of who did what, with the passkey's name the person chose.
import { newId, type SqlRunner } from "@oks-page/db";

export type PasskeyChange = "added" | "removed";

export async function recordPasskeyChange(
  runner: SqlRunner,
  siteId: string,
  userId: string,
  change: PasskeyChange,
  name: string,
  now: () => number = Date.now,
): Promise<void> {
  await runner.all(
    `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id",
      "detail", "created_at") values (?, ?, 'user', ?, ?, 'user', ?, ?, ?)`,
    [
      newId(),
      siteId,
      userId,
      change === "added" ? "passkey.add" : "passkey.remove",
      userId,
      JSON.stringify({ name: name.slice(0, 100) }),
      new Date(now()),
    ],
  );
}
