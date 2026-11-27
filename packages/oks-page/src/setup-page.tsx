// /admin/setup: the first-run wizard. Closed for good once an Administrator exists.
import { isSetupDone } from "@oks-page/core";
import type { Metadata } from "next";
import { connection } from "next/server";
import { getRunner } from "./db";
import { SetupWizard } from "./wizard";

export const metadata: Metadata = { title: "Set up your site", robots: { index: false } };

export default async function SetupPage() {
  await connection();
  const done = await isSetupDone(getRunner());
  return (
    <main>
      {done ? (
        <>
          <h1>Set up your site</h1>
          <p>
            This site is already set up. <a href="/">View the site</a>.
          </p>
        </>
      ) : (
        <SetupWizard />
      )}
    </main>
  );
}
