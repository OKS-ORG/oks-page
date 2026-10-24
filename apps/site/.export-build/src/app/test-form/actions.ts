"use server";
// Test builds only: a Server Action that saves an entry the way the admin will (the revision rule), then refreshes
// its cache tag with updateTag (SEO-06): the next visit, by anyone, is a fresh page.
import { saveEntry } from "@oks-page/db";
import { updateTag } from "next/cache";
import { getRunner } from "../../db";

export async function saveTitle(formData: FormData) {
  if (!process.env["OKS_TEST"]) throw new Error("Not available");
  const id = String(formData.get("id"));
  const title = String(formData.get("title"));
  const db = getRunner();
  const row = (await db.all(`select "revision" from "entries" where "id" = ?`, [id]))[0];
  if (!row) throw new Error("No such entry");
  const result = await saveEntry(db, {
    entryId: id,
    fromRevision: Number(row["revision"]),
    changes: { title, html: `<p>${title} body</p>` },
  });
  if (!result.ok) throw new Error("The entry changed while saving");
  updateTag(`entry:${id}`);
}
