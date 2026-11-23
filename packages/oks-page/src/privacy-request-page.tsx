// /privacy-request: where a visitor asks to see or delete the personal data the site keeps about them (spec 18, section 5).
import { isSetupDone, loadGeneralSettings } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getRunner, getSiteId } from "./db";
import { PrivacyRequestForm } from "./privacy-request-form";

export const metadata: Metadata = { title: "Your personal data", robots: { index: false } };

export default async function PrivacyRequestPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const name = (await loadGeneralSettings(getRunner(), await getSiteId())).siteName;
  return (
    <main
      style={{
        maxInlineSize: "40rem",
        margin: "4rem auto",
        padding: "0 1rem",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>Your personal data</h1>
      <p>
        {name} may keep some information about you, for example the messages you sent through a
        form. You can ask for a copy of it, or ask for it to be deleted. To make sure that nobody
        asks for someone else&apos;s data, we first send a link to the address you give, and you
        confirm there. The site owner answers within 30 days.
      </p>
      <PrivacyRequestForm />
      <p>
        <a href="/">Back to the site</a>
      </p>
    </main>
  );
}
